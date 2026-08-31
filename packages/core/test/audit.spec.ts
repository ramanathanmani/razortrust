import { describe, expect, it } from 'vitest';

import type { AuditEvent, AuditEventInput } from '../src/audit/events.js';
import {
  appendEvent,
  createCheckpoint,
  GENESIS_HASH,
  verifyChain,
  verifyCheckpoint,
  verifyFromCheckpoint,
} from '../src/audit/hashchain.js';
import { ATTACKER_KEYS, KEYS } from './fixtures.js';

function event(
  eventType: AuditEventInput['eventType'],
  payload: Record<string, unknown> = {},
  occurredAt = '2026-08-28T12:00:00.000Z',
): AuditEventInput {
  return {
    tenantId: 'tenant_acme',
    actorType: 'agent',
    actorId: 'agent_procurement_01',
    eventType,
    mandateId: 'mandate_1',
    intentId: 'intent_1',
    payload,
    occurredAt,
  };
}

/** A short but realistic run: quote, decision, hold, capture. */
function buildChain(): AuditEvent[] {
  const inputs: AuditEventInput[] = [
    event('mandate.activated', { termsHash: 'abc123' }),
    event('intent.created', { merchantId: 'merchant_officedepot_in' }),
    event('quote.submitted', { totalPaise: '249900' }),
    event('drift.evaluated', { decision: 'allow', violations: [] }),
    event('authorization.succeeded', { amountPaise: '249900', capture: 'manual' }),
    event('capture.succeeded', { amountPaise: '249900' }),
  ];

  const chain: AuditEvent[] = [];
  let head: { seq: number; hash: string } | null = null;
  for (const input of inputs) {
    const appended = appendEvent({ event: input, head });
    chain.push(appended);
    head = { seq: appended.seq, hash: appended.hash };
  }
  return chain;
}

describe('hash chain', () => {
  it('anchors the first entry to the genesis hash', () => {
    const [first] = buildChain();
    expect(first?.seq).toBe(1);
    expect(first?.prevHash).toBe(GENESIS_HASH);
  });

  it('verifies a well-formed chain', () => {
    const result = verifyChain(buildChain());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.count).toBe(6);
  });

  it('verifies an empty chain', () => {
    expect(verifyChain([]).ok).toBe(true);
  });

  it('detects an edited payload', () => {
    const chain = buildChain();
    // Someone quietly rewrites the captured amount.
    chain[4] = { ...chain[4]!, payload: { amountPaise: '9900', capture: 'manual' } };
    const result = verifyChain(chain);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('HASH_MISMATCH');
      expect(result.failedAtSeq).toBe(5);
    }
  });

  it('detects a deleted entry', () => {
    const chain = buildChain();
    chain.splice(3, 1); // remove the drift decision
    const result = verifyChain(chain);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('SEQ_GAP');
  });

  it('detects reordering', () => {
    const chain = buildChain();
    const tmp = chain[2]!;
    chain[2] = chain[3]!;
    chain[3] = tmp;
    const result = verifyChain(chain);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('SEQ_GAP');
  });

  it('detects a spliced-in entry that breaks the link', () => {
    const chain = buildChain();
    const forged = appendEvent({
      event: event('drift.evaluated', { decision: 'allow', violations: [] }),
      head: { seq: 3, hash: 'f'.repeat(64) },
    });
    chain[3] = forged;
    const result = verifyChain(chain);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('PREV_HASH_MISMATCH');
  });

  it('lets a full rewrite pass a bare chain check — which is why checkpoints exist', () => {
    // The attacker regenerates every hash consistently after editing entry 5.
    const inputs = buildChain().map((e, i) =>
      i === 4 ? { ...e, payload: { amountPaise: '1', capture: 'manual' } } : e,
    );
    const rewritten: AuditEvent[] = [];
    let head: { seq: number; hash: string } | null = null;
    for (const input of inputs) {
      const appended = appendEvent({ event: input, head });
      rewritten.push(appended);
      head = { seq: appended.seq, hash: appended.hash };
    }
    expect(verifyChain(rewritten).ok).toBe(true);
  });
});

describe('signed checkpoints', () => {
  it('verifies a checkpoint against the trusted key', () => {
    const chain = buildChain();
    const cp = createCheckpoint({
      tenantId: 'tenant_acme',
      upToSeq: chain.length,
      headHash: chain.at(-1)!.hash,
      createdAt: '2026-08-28T12:05:00.000Z',
      privateKeyPem: KEYS.privateKeyPem,
      publicKeyPem: KEYS.publicKeyPem,
    });
    expect(verifyCheckpoint(cp, KEYS.publicKeyPem)).toBe(true);
    expect(verifyCheckpoint(cp, ATTACKER_KEYS.publicKeyPem)).toBe(false);
  });

  it('catches the full rewrite that a bare chain check misses', () => {
    const original = buildChain();
    const cp = createCheckpoint({
      tenantId: 'tenant_acme',
      upToSeq: 4,
      headHash: original[3]!.hash,
      createdAt: '2026-08-28T12:01:00.000Z',
      privateKeyPem: KEYS.privateKeyPem,
      publicKeyPem: KEYS.publicKeyPem,
    });

    // Attacker rewrites everything after the checkpoint.
    const forged: AuditEvent[] = [];
    let head: { seq: number; hash: string } | null = { seq: 4, hash: 'e'.repeat(64) };
    for (const input of original.slice(4)) {
      const appended = appendEvent({ event: input, head });
      forged.push(appended);
      head = { seq: appended.seq, hash: appended.hash };
    }

    const result = verifyFromCheckpoint({
      checkpoint: cp,
      trustedPublicKeyPem: KEYS.publicKeyPem,
      subsequentEvents: forged,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe('chain');
  });

  it('verifies the genuine tail after a checkpoint', () => {
    const chain = buildChain();
    const cp = createCheckpoint({
      tenantId: 'tenant_acme',
      upToSeq: 4,
      headHash: chain[3]!.hash,
      createdAt: '2026-08-28T12:01:00.000Z',
      privateKeyPem: KEYS.privateKeyPem,
      publicKeyPem: KEYS.publicKeyPem,
    });
    const result = verifyFromCheckpoint({
      checkpoint: cp,
      trustedPublicKeyPem: KEYS.publicKeyPem,
      subsequentEvents: chain.slice(4),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.headHash).toBe(chain.at(-1)!.hash);
  });

  it('rejects a tampered checkpoint body', () => {
    const chain = buildChain();
    const cp = createCheckpoint({
      tenantId: 'tenant_acme',
      upToSeq: 4,
      headHash: chain[3]!.hash,
      createdAt: '2026-08-28T12:01:00.000Z',
      privateKeyPem: KEYS.privateKeyPem,
      publicKeyPem: KEYS.publicKeyPem,
    });
    expect(verifyCheckpoint({ ...cp, headHash: 'd'.repeat(64) }, KEYS.publicKeyPem)).toBe(false);
  });
});
