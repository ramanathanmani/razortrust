import { describe, expect, it } from 'vitest';

import { hashMandateTerms } from '../src/mandate/hash.js';
import { signMandate } from '../src/mandate/sign.js';
import { mandateTermsSchema, type MandateState } from '../src/mandate/types.js';
import { verifyMandate } from '../src/mandate/verify.js';
import { ATTACKER_KEYS, KEYS, NOW, mandateTermsFixture } from './fixtures.js';

const SIGNED_AT = '2026-08-28T09:00:00.000Z';

function sign(overrides = {}) {
  return signMandate(mandateTermsFixture(overrides), KEYS.privateKeyPem, KEYS.publicKeyPem, SIGNED_AT);
}

const cleanState: MandateState = {
  status: 'active',
  usesCount: 0,
  cumulativeAuthorizedPaise: 0n,
};

const presentedBy = { tenantId: 'tenant_acme', agentId: 'agent_procurement_01' };

describe('mandate hashing', () => {
  it('is stable across key ordering in the input', () => {
    const a = mandateTermsSchema.parse(mandateTermsFixture());
    const shuffled = mandateTermsFixture();
    const reordered = Object.fromEntries(
      Object.entries(shuffled).sort(() => -1),
    ) as typeof shuffled;
    expect(hashMandateTerms(a)).toBe(hashMandateTerms(mandateTermsSchema.parse(reordered)));
  });

  it('changes when any term changes — one paise is enough', () => {
    const base = mandateTermsSchema.parse(mandateTermsFixture());
    const nudged = mandateTermsSchema.parse(mandateTermsFixture({ maxAmountPaise: '250001' }));
    expect(hashMandateTerms(base)).not.toBe(hashMandateTerms(nudged));
  });

  it('distinguishes two otherwise-identical mandates by nonce', () => {
    const a = mandateTermsSchema.parse(mandateTermsFixture({ nonce: 'aaaaaaaaaaaaaaaa' }));
    const b = mandateTermsSchema.parse(mandateTermsFixture({ nonce: 'bbbbbbbbbbbbbbbb' }));
    expect(hashMandateTerms(a)).not.toBe(hashMandateTerms(b));
  });
});

describe('mandate schema', () => {
  it('rejects a cumulative ceiling below the single-payment ceiling', () => {
    expect(() =>
      mandateTermsSchema.parse(
        mandateTermsFixture({ maxAmountPaise: '500000', maxCumulativeAmountPaise: '100000' }),
      ),
    ).toThrow();
  });

  it('rejects a capture deadline beyond the Razorpay 3-day ceiling', () => {
    expect(() =>
      mandateTermsSchema.parse(mandateTermsFixture({ captureDeadlineHours: 96 })),
    ).toThrow();
  });

  it('rejects an empty SKU allowlist — a budget is not a mandate', () => {
    expect(() => mandateTermsSchema.parse(mandateTermsFixture({ allowedItems: [] }))).toThrow();
  });

  it('rejects unknown fields rather than silently ignoring them', () => {
    expect(() =>
      mandateTermsSchema.parse({ ...mandateTermsFixture(), sneakyOverride: true }),
    ).toThrow();
  });

  it('rejects a delivery window that ends before it starts', () => {
    expect(() =>
      mandateTermsSchema.parse(
        mandateTermsFixture({
          deliveryWindow: {
            startsAt: '2026-09-05T00:00:00.000Z',
            endsAt: '2026-08-29T00:00:00.000Z',
          },
        }),
      ),
    ).toThrow();
  });
});

describe('verifyMandate', () => {
  it('accepts a well-formed, in-force mandate', () => {
    const result = verifyMandate({ mandate: sign(), state: cleanState, presentedBy, now: NOW });
    expect(result.ok).toBe(true);
  });

  it('catches a term edited after signing', () => {
    const mandate = sign();
    // The classic attack: raise the ceiling in the database, leave the
    // signature alone.
    const tampered = {
      ...mandate,
      terms: { ...mandate.terms, maxAmountPaise: 749_999n },
    };
    const result = verifyMandate({ mandate: tampered, state: cleanState, presentedBy, now: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures[0]?.code).toBe('HASH_MISMATCH');
  });

  it('catches a rewritten hash that no longer matches the signature', () => {
    const mandate = sign();
    const forgedTerms = { ...mandate.terms, maxAmountPaise: 749_999n };
    // Attacker recomputes the hash too — but cannot produce the signature.
    const tampered = {
      ...mandate,
      terms: forgedTerms,
      termsHash: hashMandateTerms(forgedTerms),
    };
    const result = verifyMandate({ mandate: tampered, state: cleanState, presentedBy, now: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures[0]?.code).toBe('BAD_SIGNATURE');
  });

  it('rejects a mandate signed by the wrong key', () => {
    const mandate = signMandate(
      mandateTermsFixture(),
      ATTACKER_KEYS.privateKeyPem,
      KEYS.publicKeyPem, // claims to be the principal's key
      SIGNED_AT,
    );
    const result = verifyMandate({ mandate, state: cleanState, presentedBy, now: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures[0]?.code).toBe('BAD_SIGNATURE');
  });

  it('rejects a revoked mandate even though the signature is fine', () => {
    const result = verifyMandate({
      mandate: sign(),
      state: { ...cleanState, status: 'revoked', revokedAt: '2026-08-28T11:00:00.000Z' },
      presentedBy,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures.map((f) => f.code)).toContain('REVOKED');
  });

  it('rejects a mandate outside its validity window', () => {
    const early = verifyMandate({
      mandate: sign(),
      state: cleanState,
      presentedBy,
      now: new Date('2026-08-27T00:00:00.000Z'),
    });
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.failures.map((f) => f.code)).toContain('NOT_YET_VALID');

    const late = verifyMandate({
      mandate: sign(),
      state: cleanState,
      presentedBy,
      now: new Date('2026-09-10T00:00:00.000Z'),
    });
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.failures.map((f) => f.code)).toContain('EXPIRED');
  });

  it('rejects a mandate whose uses are spent', () => {
    const result = verifyMandate({
      mandate: sign(),
      state: { ...cleanState, usesCount: 3 },
      presentedBy,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures.map((f) => f.code)).toContain('USES_EXHAUSTED');
  });

  it('blocks death-by-a-thousand-small-purchases via the cumulative ceiling', () => {
    const result = verifyMandate({
      mandate: sign(),
      state: { ...cleanState, usesCount: 2, cumulativeAuthorizedPaise: 750_000n },
      presentedBy,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failures.map((f) => f.code)).toContain('CUMULATIVE_CEILING_REACHED');
    }
  });

  it('refuses a mandate borrowed by a different agent', () => {
    const result = verifyMandate({
      mandate: sign(),
      state: cleanState,
      presentedBy: { tenantId: 'tenant_acme', agentId: 'agent_someone_else' },
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures.map((f) => f.code)).toContain('AGENT_MISMATCH');
  });

  it('refuses a mandate presented across a tenant boundary', () => {
    const result = verifyMandate({
      mandate: sign(),
      state: cleanState,
      presentedBy: { tenantId: 'tenant_other', agentId: 'agent_procurement_01' },
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures.map((f) => f.code)).toContain('TENANT_MISMATCH');
  });
});
