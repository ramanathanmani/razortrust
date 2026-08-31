/**
 * The only way anything gets into the audit log.
 *
 * There is no other writer, and there is no update path. The chain arithmetic
 * itself lives in @razortrust/core; this file is the storage half: pick the
 * next seq under a lock, hash against the current head, insert, and let the
 * unique constraint on (tenantId, seq) settle any race we lost.
 */
import {
  appendEvent,
  createCheckpoint,
  GENESIS_HASH,
  verifyChain,
  verifyFromCheckpoint,
  type AuditEvent,
  type AuditEventInput,
  type SignedCheckpoint,
} from '@razortrust/core';

import { prisma, type Db } from './client.js';
import { fromCanonicalJson, toCanonicalJson } from './json.js';

type Tx = Db | Parameters<Parameters<Db['$transaction']>[0]>[0];

/** How many times to retry when another writer took the seq we wanted. */
const MAX_SEQ_RETRIES = 5;

function rowToEvent(row: {
  seq: number;
  tenantId: string;
  actorType: string;
  actorId: string;
  eventType: string;
  mandateId: string | null;
  intentId: string | null;
  payloadJson: string;
  prevHash: string;
  hash: string;
  occurredAt: Date;
}): AuditEvent {
  return {
    seq: row.seq,
    tenantId: row.tenantId,
    actorType: row.actorType as AuditEvent['actorType'],
    actorId: row.actorId,
    eventType: row.eventType as AuditEvent['eventType'],
    ...(row.mandateId ? { mandateId: row.mandateId } : {}),
    ...(row.intentId ? { intentId: row.intentId } : {}),
    payload: fromCanonicalJson(row.payloadJson),
    prevHash: row.prevHash,
    hash: row.hash,
    occurredAt: row.occurredAt.toISOString(),
  };
}

/**
 * Append one event.
 *
 * Pass `tx` when the event belongs to a larger transaction — an authorization
 * and its `authorization.succeeded` entry must land together or not at all.
 */
export async function recordAuditEvent(
  event: AuditEventInput,
  tx: Tx = prisma,
): Promise<AuditEvent> {
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_SEQ_RETRIES; attempt += 1) {
    const head = await tx.auditEvent.findFirst({
      where: { tenantId: event.tenantId },
      orderBy: { seq: 'desc' },
      select: { seq: true, hash: true },
    });

    const next = appendEvent({ event, head: head ?? null });

    try {
      await tx.auditEvent.create({
        data: {
          seq: next.seq,
          tenantId: next.tenantId,
          actorType: next.actorType,
          actorId: next.actorId,
          eventType: next.eventType,
          mandateId: next.mandateId ?? null,
          intentId: next.intentId ?? null,
          payloadJson: toCanonicalJson(next.payload),
          prevHash: next.prevHash,
          hash: next.hash,
          occurredAt: new Date(next.occurredAt),
        },
      });
      return next;
    } catch (err) {
      // Unique violation on (tenantId, seq) or on hash: another writer beat us
      // to this position. Re-read the head and try again rather than forcing.
      lastError = err;
      if (!isUniqueViolation(err)) throw err;
    }
  }

  throw new Error(
    `Could not append audit event after ${MAX_SEQ_RETRIES} attempts (seq contention): ${String(lastError)}`,
  );
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'P2002'
  );
}

export async function getAuditEvents(args: {
  tenantId: string;
  fromSeq?: number;
  toSeq?: number;
  intentId?: string;
  mandateId?: string;
  limit?: number;
}): Promise<AuditEvent[]> {
  const rows = await prisma.auditEvent.findMany({
    where: {
      tenantId: args.tenantId,
      ...(args.fromSeq !== undefined || args.toSeq !== undefined
        ? {
            seq: {
              ...(args.fromSeq !== undefined ? { gte: args.fromSeq } : {}),
              ...(args.toSeq !== undefined ? { lte: args.toSeq } : {}),
            },
          }
        : {}),
      ...(args.intentId ? { intentId: args.intentId } : {}),
      ...(args.mandateId ? { mandateId: args.mandateId } : {}),
    },
    orderBy: { seq: 'asc' },
    take: args.limit ?? 1000,
  });
  return rows.map(rowToEvent);
}

export async function getChainHead(
  tenantId: string,
): Promise<{ seq: number; hash: string } | null> {
  const head = await prisma.auditEvent.findFirst({
    where: { tenantId },
    orderBy: { seq: 'desc' },
    select: { seq: true, hash: true },
  });
  return head ?? null;
}

/** Write a signed checkpoint at the current head. */
export async function writeCheckpoint(args: {
  tenantId: string;
  privateKeyPem: string;
  publicKeyPem: string;
  now: Date;
}): Promise<SignedCheckpoint | null> {
  const head = await getChainHead(args.tenantId);
  if (!head) return null;

  const existing = await prisma.auditCheckpoint.findUnique({
    where: { tenantId_upToSeq: { tenantId: args.tenantId, upToSeq: head.seq } },
  });
  if (existing) return null; // already checkpointed at this head

  const checkpoint = createCheckpoint({
    tenantId: args.tenantId,
    upToSeq: head.seq,
    headHash: head.hash,
    createdAt: args.now.toISOString(),
    privateKeyPem: args.privateKeyPem,
    publicKeyPem: args.publicKeyPem,
  });

  await prisma.auditCheckpoint.create({
    data: {
      tenantId: checkpoint.tenantId,
      upToSeq: checkpoint.upToSeq,
      headHash: checkpoint.headHash,
      signature: checkpoint.signature,
      signedByPublicKeyPem: checkpoint.signedByPublicKeyPem,
      createdAt: new Date(checkpoint.createdAt),
    },
  });

  return checkpoint;
}

export async function getLatestCheckpoint(tenantId: string): Promise<SignedCheckpoint | null> {
  const row = await prisma.auditCheckpoint.findFirst({
    where: { tenantId },
    orderBy: { upToSeq: 'desc' },
  });
  if (!row) return null;
  return {
    domain: 'razortrust.audit.checkpoint.v1',
    tenantId: row.tenantId,
    upToSeq: row.upToSeq,
    headHash: row.headHash,
    createdAt: row.createdAt.toISOString(),
    signature: row.signature,
    signedByPublicKeyPem: row.signedByPublicKeyPem,
  };
}

export type AuditIntegrityReport =
  | {
      ok: true;
      mode: 'checkpointed' | 'full';
      verifiedFromSeq: number;
      headSeq: number;
      headHash: string;
    }
  | { ok: false; mode: 'checkpointed' | 'full'; message: string };

/**
 * What `GET /v1/audit/verify` answers.
 *
 * Prefers verifying from the latest signed checkpoint, because that is the
 * check a rewrite cannot pass. Falls back to a bare chain replay when no
 * checkpoint exists yet, and says so — an unsigned result is weaker evidence
 * and the caller should be able to tell.
 */
export async function verifyAuditIntegrity(args: {
  tenantId: string;
  trustedPublicKeyPem?: string;
}): Promise<AuditIntegrityReport> {
  const checkpoint = await getLatestCheckpoint(args.tenantId);
  const trustedKey = args.trustedPublicKeyPem ?? checkpoint?.signedByPublicKeyPem;

  if (checkpoint && trustedKey) {
    const subsequent = await getAuditEvents({
      tenantId: args.tenantId,
      fromSeq: checkpoint.upToSeq + 1,
      limit: 100_000,
    });
    const result = verifyFromCheckpoint({
      checkpoint,
      trustedPublicKeyPem: trustedKey,
      subsequentEvents: subsequent,
    });
    if (!result.ok) return { ok: false, mode: 'checkpointed', message: result.message };
    return {
      ok: true,
      mode: 'checkpointed',
      verifiedFromSeq: checkpoint.upToSeq,
      headSeq: checkpoint.upToSeq + subsequent.length,
      headHash: result.headHash,
    };
  }

  const all = await getAuditEvents({ tenantId: args.tenantId, limit: 100_000 });
  const result = verifyChain(all, GENESIS_HASH);
  if (!result.ok) return { ok: false, mode: 'full', message: result.message };
  return {
    ok: true,
    mode: 'full',
    verifiedFromSeq: 0,
    headSeq: all.length,
    headHash: result.headHash,
  };
}
