import { describe, expect, it } from 'vitest';

import type { StructuredQuoteInput } from '../src/drift/types.js';
import { mandateTermsSchema } from '../src/mandate/types.js';
import { evaluateSettlement } from '../src/settlement/evaluate.js';
import { SETTLEMENT_RULES_VERSION } from '../src/settlement/rules.js';
import type { DeliveryEvidenceInput } from '../src/settlement/types.js';
import { mandateTermsFixture } from './fixtures.js';

const mandate = mandateTermsSchema.parse(mandateTermsFixture());
const autoMandate = mandateTermsSchema.parse(mandateTermsFixture({ autoRefundAllowed: true }));

/** One keyboard at ₹1,750 and two cables at ₹500 each. Captured: ₹2,449. */
function quote(overrides: Partial<StructuredQuoteInput> = {}): StructuredQuoteInput {
  return {
    quoteVersion: 1,
    merchantId: 'merchant_officedepot_in',
    currency: 'INR',
    lineItems: [
      { sku: 'SKU-KEYBOARD-MX', unitPricePaise: '175000', quantity: 1, lineTotalPaise: '175000' },
      { sku: 'SKU-USBC-CABLE-2M', unitPricePaise: '50000', quantity: 2, lineTotalPaise: '100000' },
    ],
    subtotalPaise: '275000',
    taxPaise: '20000',
    shippingPaise: '5000',
    discountPaise: '55100',
    totalPaise: '244900',
    promisedDeliveryAt: '2026-09-01T00:00:00.000Z',
    capturedAt: '2026-08-28T11:55:00.000Z',
    ...overrides,
  };
}

/** Everything arrived, on time, in good condition. */
function evidence(overrides: Partial<DeliveryEvidenceInput> = {}): DeliveryEvidenceInput {
  return {
    evidenceVersion: 1,
    status: 'delivered',
    trackingId: 'TRK-99881',
    carrier: 'Bluedart',
    shippedAt: '2026-08-30T09:00:00.000Z',
    deliveredAt: '2026-09-01T10:00:00.000Z',
    lineItems: [
      { sku: 'SKU-KEYBOARD-MX', quantity: 1, condition: 'good' },
      { sku: 'SKU-USBC-CABLE-2M', quantity: 2, condition: 'good' },
    ],
    ...overrides,
  };
}

const NOW_AFTER_DELIVERY = new Date('2026-09-02T00:00:00.000Z');

function settle(
  ev: DeliveryEvidenceInput | unknown,
  opts: Partial<Parameters<typeof evaluateSettlement>[0]> = {},
) {
  return evaluateSettlement({
    mandate,
    quote: quote(),
    evidence: ev,
    now: NOW_AFTER_DELIVERY,
    capturedAmountPaise: 244_900n,
    alreadyRefundedPaise: 0n,
    ...opts,
  });
}

const ruleIds = (r: ReturnType<typeof settle>) => r.reasons.map((x) => x.ruleId);

describe('a clean delivery', () => {
  it('recommends nothing', () => {
    const result = settle(evidence());
    expect(result.recommendation).toBe('none');
    expect(result.refundAmountPaise).toBe(0n);
    expect(result.reasons).toEqual([]);
  });

  it('stamps the rules version', () => {
    expect(settle(evidence()).rulesVersion).toBe(SETTLEMENT_RULES_VERSION);
  });
});

describe('full refunds', () => {
  it('refunds in full when the delivery failed', () => {
    const result = settle(evidence({ status: 'failed', deliveredAt: undefined }));
    expect(result.recommendation).toBe('full_refund');
    expect(result.refundAmountPaise).toBe(244_900n);
    expect(ruleIds(result)).toContain('DELIVERY_FAILED');
  });

  it('refunds in full when the order was returned', () => {
    const result = settle(evidence({ status: 'returned', deliveredAt: undefined }));
    expect(result.recommendation).toBe('full_refund');
  });

  it('refunds in full when the shipment was lost', () => {
    const result = settle(evidence({ status: 'lost', deliveredAt: undefined }));
    expect(ruleIds(result)).toContain('LOST_IN_TRANSIT');
    expect(result.refundAmountPaise).toBe(244_900n);
  });

  it('refunds in full when marked delivered but nothing arrived', () => {
    const result = settle(evidence({ lineItems: [] }));
    expect(result.recommendation).toBe('full_refund');
    expect(ruleIds(result)).toContain('NOTHING_OF_VALUE_DELIVERED');
    expect(result.refundAmountPaise).toBe(244_900n);
  });

  it('never refunds more than was captured', () => {
    const result = settle(evidence({ status: 'failed' }), { capturedAmountPaise: 100_000n });
    expect(result.refundAmountPaise).toBe(100_000n);
  });

  it('accounts for money already refunded', () => {
    const result = settle(evidence({ status: 'failed' }), { alreadyRefundedPaise: 200_000n });
    expect(result.refundAmountPaise).toBe(44_900n);
  });
});

describe('partial refunds', () => {
  it('refunds the value of a line that never arrived', () => {
    const result = settle(
      evidence({ lineItems: [{ sku: 'SKU-KEYBOARD-MX', quantity: 1, condition: 'good' }] }),
    );
    expect(result.recommendation).toBe('partial_refund');
    expect(ruleIds(result)).toContain('ITEM_NOT_DELIVERED');
    // Two cables at ₹500 each.
    expect(result.refundAmountPaise).toBe(100_000n);
  });

  it('refunds proportionally on a short quantity', () => {
    const result = settle(
      evidence({
        lineItems: [
          { sku: 'SKU-KEYBOARD-MX', quantity: 1, condition: 'good' },
          { sku: 'SKU-USBC-CABLE-2M', quantity: 1, condition: 'good' },
        ],
      }),
    );
    expect(ruleIds(result)).toContain('SHORT_QUANTITY');
    expect(result.refundAmountPaise).toBe(50_000n);
  });

  it('treats damaged units as not delivered, and refunds them', () => {
    const result = settle(
      evidence({
        lineItems: [
          { sku: 'SKU-KEYBOARD-MX', quantity: 1, condition: 'damaged' },
          { sku: 'SKU-USBC-CABLE-2M', quantity: 2, condition: 'good' },
        ],
      }),
    );
    expect(result.recommendation).toBe('partial_refund');
    expect(ruleIds(result)).toContain('ITEM_DAMAGED');
    expect(ruleIds(result)).toContain('ITEM_NOT_DELIVERED');
    // The keyboard is named by two rules but paid back once.
    expect(result.refundAmountPaise).toBe(175_000n);
  });

  it('caps a partial refund at what remains refundable', () => {
    const result = settle(
      evidence({ lineItems: [{ sku: 'SKU-KEYBOARD-MX', quantity: 1, condition: 'good' }] }),
      { capturedAmountPaise: 244_900n, alreadyRefundedPaise: 220_000n },
    );
    expect(result.refundAmountPaise).toBe(24_900n);
  });
});

describe('escalation — when code should not decide', () => {
  it('escalates a late delivery rather than inventing a discount', () => {
    const result = settle(evidence({ deliveredAt: '2026-09-10T00:00:00.000Z' }), {
      now: new Date('2026-09-11T00:00:00.000Z'),
    });
    expect(result.recommendation).toBe('escalate');
    expect(ruleIds(result)).toContain('DELIVERED_AFTER_WINDOW');
    expect(result.refundAmountPaise).toBe(0n);
  });

  it('escalates a delivery with no tracking and no proof', () => {
    const result = settle(
      evidence({ trackingId: undefined, carrier: undefined, proofOfDeliveryRef: undefined }),
    );
    expect(ruleIds(result)).toContain('NO_TRACKING_EVIDENCE');
    expect(result.recommendation).toBe('escalate');
  });

  it('accepts proof of delivery in place of a tracking id', () => {
    const result = settle(
      evidence({ trackingId: undefined, proofOfDeliveryRef: 'POD-4471' }),
    );
    expect(ruleIds(result)).not.toContain('NO_TRACKING_EVIDENCE');
  });

  it('escalates delivered-before-shipped', () => {
    const result = settle(
      evidence({ shippedAt: '2026-09-01T12:00:00.000Z', deliveredAt: '2026-09-01T10:00:00.000Z' }),
    );
    expect(ruleIds(result)).toContain('DELIVERED_BEFORE_SHIPPED');
    expect(result.recommendation).toBe('escalate');
  });

  it('escalates a timestamp in the future', () => {
    const result = settle(evidence({ deliveredAt: '2027-01-01T00:00:00.000Z' }));
    expect(ruleIds(result)).toContain('TIMESTAMP_IN_FUTURE');
  });

  it('escalates goods that were never quoted', () => {
    const result = settle(
      evidence({
        lineItems: [
          { sku: 'SKU-KEYBOARD-MX', quantity: 1, condition: 'good' },
          { sku: 'SKU-USBC-CABLE-2M', quantity: 2, condition: 'good' },
          { sku: 'SKU-MYSTERY-BOX', quantity: 1, condition: 'good' },
        ],
      }),
    );
    expect(ruleIds(result)).toContain('WRONG_SKU_DELIVERED');
    expect(result.recommendation).toBe('escalate');
  });

  it('escalates rather than guessing when the evidence will not parse', () => {
    const result = settle({ garbage: true });
    expect(result.recommendation).toBe('escalate');
    expect(ruleIds(result)).toContain('EVIDENCE_MALFORMED');
  });

  it('never concludes "none" from unreadable evidence', () => {
    for (const bad of [null, undefined, 42, 'delivered', [], {}]) {
      expect(settle(bad).recommendation).toBe('escalate');
    }
  });
});

describe('verdict precedence', () => {
  it('lets a full refund win over an escalation', () => {
    // Nothing arrived AND the delivery was late: the buyer got nothing, so the
    // money goes back rather than waiting on a review.
    const result = settle(
      evidence({ lineItems: [], deliveredAt: '2026-09-10T00:00:00.000Z' }),
      { now: new Date('2026-09-11T00:00:00.000Z') },
    );
    expect(ruleIds(result)).toContain('DELIVERED_AFTER_WINDOW');
    expect(result.recommendation).toBe('full_refund');
    expect(result.refundAmountPaise).toBe(244_900n);
  });

  it('lets an escalation win over a partial refund', () => {
    // A cable is missing AND an unquoted item arrived. Computing a precise
    // partial from evidence we have already called suspect would be false
    // confidence.
    const result = settle(
      evidence({
        lineItems: [
          { sku: 'SKU-KEYBOARD-MX', quantity: 1, condition: 'good' },
          { sku: 'SKU-MYSTERY-BOX', quantity: 1, condition: 'good' },
        ],
      }),
    );
    expect(ruleIds(result)).toContain('ITEM_NOT_DELIVERED');
    expect(ruleIds(result)).toContain('WRONG_SKU_DELIVERED');
    expect(result.recommendation).toBe('escalate');
    expect(result.refundAmountPaise).toBe(0n);
  });
});

describe('nothing captured', () => {
  it('recommends nothing, because a hold is released rather than refunded', () => {
    const result = settle(evidence({ status: 'failed' }), { capturedAmountPaise: 0n });
    expect(result.recommendation).toBe('none');
    expect(result.refundAmountPaise).toBe(0n);
    expect(ruleIds(result)).toContain('NOT_CAPTURED');
  });
});

describe('auto-execution', () => {
  it('stays manual when the mandate did not permit auto-refund', () => {
    const result = settle(evidence({ status: 'failed' }));
    expect(result.recommendation).toBe('full_refund');
    expect(result.autoExecutable).toBe(false);
  });

  it('is auto-executable only when the human allowed it at signing time', () => {
    const result = settle(evidence({ status: 'failed' }), { mandate: autoMandate });
    expect(result.autoExecutable).toBe(true);
  });

  it('is never auto-executable when the verdict is escalate', () => {
    const result = settle(evidence({ deliveredAt: '2026-09-10T00:00:00.000Z' }), {
      mandate: autoMandate,
      now: new Date('2026-09-11T00:00:00.000Z'),
    });
    expect(result.recommendation).toBe('escalate');
    expect(result.autoExecutable).toBe(false);
  });

  it('is never auto-executable when nothing is owed', () => {
    expect(settle(evidence(), { mandate: autoMandate }).autoExecutable).toBe(false);
  });
});

describe('determinism', () => {
  it('gives the same recommendation every time', () => {
    const runs = Array.from({ length: 25 }, () =>
      settle(evidence({ lineItems: [{ sku: 'SKU-KEYBOARD-MX', quantity: 1, condition: 'good' }] })),
    );
    const first = JSON.stringify(runs[0], (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    expect(
      runs.every(
        (r) => JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) === first,
      ),
    ).toBe(true);
  });
});
