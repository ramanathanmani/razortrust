/**
 * The audit log: append-only and tamper-EVIDENT.
 *
 * Not "immutable" — a database row can always be edited by someone with the
 * right access. What this gives you is detection. Each entry hashes the entry
 * before it, so editing entry 40 invalidates 41 onward. Rewriting the whole
 * tail to cover that up is defeated by the checkpoints: periodically the head
 * hash is signed with an Ed25519 key, so a forger would also need the signing
 * key to produce a chain that verifies.
 *
 * Pure functions only. Storage, ordering and locking are the DB's job.
 */
import { canonicalize } from '../canonical.js';
import { hashEquals, sha256Canonical, signCanonical, verifyCanonical } from '../crypto.js';
import type { AuditEvent, AuditEventInput } from './events.js';

export const AUDIT_HASH_DOMAIN = 'razortrust.audit.v1' as const;
export const CHECKPOINT_DOMAIN = 'razortrust.audit.checkpoint.v1' as const;

/** The chain's anchor: 64 zeroes, the `prevHash` of entry 1. */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * Hash one entry.
 *
 * Everything that identifies the event is inside the hash, including `seq` and
 * `prevHash`, so an entry cannot be moved to a different position in the chain
 * and still verify.
 */
export function hashAuditEvent(args: {
  readonly seq: number;
  readonly prevHash: string;
  readonly event: AuditEventInput;
}): string {
  return sha256Canonical({
    domain: AUDIT_HASH_DOMAIN,
    seq: args.seq,
    prevHash: args.prevHash,
    tenantId: args.event.tenantId,
    actorType: args.event.actorType,
    actorId: args.event.actorId,
    eventType: args.event.eventType,
    mandateId: args.event.mandateId ?? null,
    intentId: args.event.intentId ?? null,
    occurredAt: args.event.occurredAt,
    // Canonicalized separately so payload shape can evolve without changing
    // how the outer envelope hashes.
    payloadHash: sha256Canonical(args.event.payload),
  });
}

/** Build the next entry given the current chain head. */
export function appendEvent(args: {
  readonly event: AuditEventInput;
  readonly head: { readonly seq: number; readonly hash: string } | null;
}): AuditEvent {
  const seq = (args.head?.seq ?? 0) + 1;
  const prevHash = args.head?.hash ?? GENESIS_HASH;
  return {
    ...args.event,
    seq,
    prevHash,
    hash: hashAuditEvent({ seq, prevHash, event: args.event }),
  };
}

export type ChainVerification =
  | { readonly ok: true; readonly count: number; readonly headHash: string }
  | {
      readonly ok: false;
      readonly failedAtSeq: number;
      readonly reason: 'SEQ_GAP' | 'PREV_HASH_MISMATCH' | 'HASH_MISMATCH';
      readonly message: string;
    };

/**
 * Recompute a run of the chain.
 *
 * `expectedFirstPrevHash` lets a caller verify a slice starting mid-chain
 * (say, from the last checkpoint) instead of replaying everything.
 */
export function verifyChain(
  events: readonly AuditEvent[],
  expectedFirstPrevHash: string = GENESIS_HASH,
): ChainVerification {
  if (events.length === 0) {
    return { ok: true, count: 0, headHash: expectedFirstPrevHash };
  }

  let prevHash = expectedFirstPrevHash;
  let prevSeq = (events[0]?.seq ?? 1) - 1;

  for (const event of events) {
    if (event.seq !== prevSeq + 1) {
      return {
        ok: false,
        failedAtSeq: event.seq,
        reason: 'SEQ_GAP',
        message: `Expected seq ${prevSeq + 1} but found ${event.seq} — entries are missing or reordered`,
      };
    }

    if (!hashEquals(event.prevHash, prevHash)) {
      return {
        ok: false,
        failedAtSeq: event.seq,
        reason: 'PREV_HASH_MISMATCH',
        message: `Entry ${event.seq} does not link to the previous entry — the chain was cut or spliced`,
      };
    }

    const recomputed = hashAuditEvent({ seq: event.seq, prevHash: event.prevHash, event });
    if (!hashEquals(recomputed, event.hash)) {
      return {
        ok: false,
        failedAtSeq: event.seq,
        reason: 'HASH_MISMATCH',
        message: `Entry ${event.seq} does not match its stored hash — its contents were altered`,
      };
    }

    prevHash = event.hash;
    prevSeq = event.seq;
  }

  return { ok: true, count: events.length, headHash: prevHash };
}

// --------------------------------------------------------------------------
// Checkpoints
// --------------------------------------------------------------------------

export interface CheckpointBody {
  readonly domain: typeof CHECKPOINT_DOMAIN;
  readonly tenantId: string;
  readonly upToSeq: number;
  readonly headHash: string;
  readonly createdAt: string;
}

export interface SignedCheckpoint extends CheckpointBody {
  readonly signature: string;
  readonly signedByPublicKeyPem: string;
}

/**
 * Sign the chain head.
 *
 * Run every N events and on a timer. Without this, anyone who can write to the
 * table can also recompute a consistent chain; with it, they would need the
 * signing key too.
 */
export function createCheckpoint(args: {
  readonly tenantId: string;
  readonly upToSeq: number;
  readonly headHash: string;
  readonly createdAt: string;
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
}): SignedCheckpoint {
  const body: CheckpointBody = {
    domain: CHECKPOINT_DOMAIN,
    tenantId: args.tenantId,
    upToSeq: args.upToSeq,
    headHash: args.headHash,
    createdAt: args.createdAt,
  };
  return {
    ...body,
    signature: signCanonical(body, args.privateKeyPem),
    signedByPublicKeyPem: args.publicKeyPem,
  };
}

export function verifyCheckpoint(checkpoint: SignedCheckpoint, publicKeyPem: string): boolean {
  const body: CheckpointBody = {
    domain: CHECKPOINT_DOMAIN,
    tenantId: checkpoint.tenantId,
    upToSeq: checkpoint.upToSeq,
    headHash: checkpoint.headHash,
    createdAt: checkpoint.createdAt,
  };
  return verifyCanonical(body, checkpoint.signature, publicKeyPem);
}

export type CheckpointedVerification =
  | { readonly ok: true; readonly verifiedFromSeq: number; readonly headHash: string }
  | { readonly ok: false; readonly stage: 'checkpoint' | 'chain'; readonly message: string };

/**
 * Full verification: the checkpoint's signature, then the chain that follows it.
 *
 * This is what `GET /v1/audit/verify` answers, and what a judge or an auditor
 * runs to convince themselves the log was not rewritten.
 */
export function verifyFromCheckpoint(args: {
  readonly checkpoint: SignedCheckpoint;
  readonly trustedPublicKeyPem: string;
  /** Events strictly after `checkpoint.upToSeq`, in ascending seq order. */
  readonly subsequentEvents: readonly AuditEvent[];
}): CheckpointedVerification {
  if (!verifyCheckpoint(args.checkpoint, args.trustedPublicKeyPem)) {
    return {
      ok: false,
      stage: 'checkpoint',
      message: `Checkpoint at seq ${args.checkpoint.upToSeq} does not verify against the trusted key`,
    };
  }

  const first = args.subsequentEvents[0];
  if (first && first.seq !== args.checkpoint.upToSeq + 1) {
    return {
      ok: false,
      stage: 'chain',
      message: `Events after the checkpoint start at seq ${first.seq}, expected ${args.checkpoint.upToSeq + 1}`,
    };
  }

  const result = verifyChain(args.subsequentEvents, args.checkpoint.headHash);
  if (!result.ok) {
    return { ok: false, stage: 'chain', message: result.message };
  }

  return {
    ok: true,
    verifiedFromSeq: args.checkpoint.upToSeq,
    headHash: result.headHash,
  };
}

/** Debug helper: the exact string that was hashed for an entry. */
export function auditPreimage(event: AuditEvent): string {
  return canonicalize({
    domain: AUDIT_HASH_DOMAIN,
    seq: event.seq,
    prevHash: event.prevHash,
    tenantId: event.tenantId,
    actorType: event.actorType,
    actorId: event.actorId,
    eventType: event.eventType,
    mandateId: event.mandateId ?? null,
    intentId: event.intentId ?? null,
    occurredAt: event.occurredAt,
    payloadHash: sha256Canonical(event.payload),
  });
}
