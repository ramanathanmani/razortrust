import { describe, expect, it } from 'vitest';

import { evaluateDrift, hashQuote } from '../src/drift/evaluate.js';
import { DRIFT_RULES, RULES_VERSION, rulesForStage } from '../src/drift/rules.js';
import { structuredQuoteSchema, type StructuredQuoteInput } from '../src/drift/types.js';
import { mandateTermsSchema } from '../src/mandate/types.js';
import { NOW, mandateTermsFixture } from './fixtures.js';

const mandate = mandateTermsSchema.parse(mandateTermsFixture());

/**
 * A clean quote: one keyboard at ₹1,750, two cables at ₹500 each, tax and
 * shipping, delivered inside the window. Total ₹2,449 — under the ₹2,500 cap.
 */
function quoteFixture(overrides: Partial<StructuredQuoteInput> = {}): StructuredQuoteInput {
  return {
    quoteVersion: 1,
    merchantId: 'merchant_officedepot_in',
    merchantName: 'Office Depot India',
    merchantQuoteRef: 'Q-88213',
    currency: 'INR',
    lineItems: [
      {
        sku: 'SKU-KEYBOARD-MX',
        description: 'Mechanical keyboard, brown switches',
        unitPricePaise: '175000',
        quantity: 1,
        lineTotalPaise: '175000',
      },
      {
        sku: 'SKU-USBC-CABLE-2M',
        unitPricePaise: '50000',
        quantity: 2,
        lineTotalPaise: '100000',
      },
    ],
    subtotalPaise: '275000',
    taxPaise: '20000',
    shippingPaise: '5000',
    discountPaise: '55100',
    totalPaise: '244900',
    promisedDeliveryAt: '2026-09-01T00:00:00.000Z',
    quoteExpiresAt: '2026-08-28T18:00:00.000Z',
    capturedAt: '2026-08-28T11:55:00.000Z',
    ...overrides,
  };
}

function check(quote: StructuredQuoteInput, opts: Partial<Parameters<typeof evaluateDrift>[0]> = {}) {
  return evaluateDrift({
    mandate,
    quote,
    stage: 'pre_authorization',
    now: NOW,
    cumulativeAuthorizedPaise: 0n,
    ...opts,
  });
}

const ruleIds = (r: ReturnType<typeof check>) => r.violations.map((v) => v.ruleId);

describe('the rules table itself', () => {
  it('has no duplicate rule ids', () => {
    const ids = DRIFT_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('runs strictly more rules at capture than at authorization', () => {
    const pre = rulesForStage('pre_authorization').length;
    const cap = rulesForStage('pre_capture').length;
    expect(cap).toBeGreaterThan(pre);
  });

  it('stamps every verdict with the rules version', () => {
    expect(check(quoteFixture()).rulesVersion).toBe(RULES_VERSION);
  });
});

describe('the happy path', () => {
  it('allows a quote that matches the mandate', () => {
    const result = check(quoteFixture());
    expect(result.violations).toEqual([]);
    expect(result.decision).toBe('allow');
  });

  it('allows a quote exactly at the ceiling — inclusive, as documented', () => {
    const result = check(
      quoteFixture({ discountPaise: '50000', totalPaise: '250000' }),
    );
    expect(result.decision).toBe('allow');
  });

  it('binds the verdict to the exact quote bytes', () => {
    const q = structuredQuoteSchema.parse(quoteFixture());
    expect(check(quoteFixture()).quoteHash).toBe(hashQuote(q));
  });
});

describe('blocking rules', () => {
  it('blocks a quote one paise over the ceiling', () => {
    const result = check(quoteFixture({ discountPaise: '49999', totalPaise: '250001' }));
    expect(result.decision).toBe('block');
    expect(ruleIds(result)).toContain('TOTAL_EXCEEDS_MANDATE_CEILING');
  });

  it('blocks a merchant swap', () => {
    const result = check(quoteFixture({ merchantId: 'merchant_somewhere_else' }));
    expect(ruleIds(result)).toContain('MERCHANT_NOT_ALLOWED');
  });

  it('blocks a SKU the human never approved', () => {
    const result = check(
      quoteFixture({
        lineItems: [
          {
            sku: 'SKU-GAMING-CHAIR',
            unitPricePaise: '175000',
            quantity: 1,
            lineTotalPaise: '175000',
          },
        ],
        subtotalPaise: '175000',
        taxPaise: '0',
        shippingPaise: '0',
        discountPaise: '0',
        totalPaise: '175000',
      }),
    );
    expect(ruleIds(result)).toContain('SKU_NOT_ALLOWED');
  });

  it('blocks a unit price above the per-item cap', () => {
    const result = check(
      quoteFixture({
        lineItems: [
          {
            sku: 'SKU-KEYBOARD-MX',
            unitPricePaise: '180001',
            quantity: 1,
            lineTotalPaise: '180001',
          },
        ],
        subtotalPaise: '180001',
        taxPaise: '0',
        shippingPaise: '0',
        discountPaise: '0',
        totalPaise: '180001',
      }),
    );
    expect(ruleIds(result)).toContain('UNIT_PRICE_EXCEEDED');
  });

  it('does not double-report price on an unknown SKU', () => {
    const result = check(
      quoteFixture({
        lineItems: [
          { sku: 'SKU-UNKNOWN', unitPricePaise: '999999', quantity: 1, lineTotalPaise: '999999' },
        ],
        subtotalPaise: '999999',
        taxPaise: '0',
        shippingPaise: '0',
        discountPaise: '0',
        totalPaise: '999999',
      }),
    );
    expect(ruleIds(result)).toContain('SKU_NOT_ALLOWED');
    expect(ruleIds(result)).not.toContain('UNIT_PRICE_EXCEEDED');
  });

  it('blocks quantity split across multiple lines to dodge the cap', () => {
    // The mandate allows ONE keyboard. Asking for it as 1 + 1 is still two.
    const result = check(
      quoteFixture({
        lineItems: [
          {
            sku: 'SKU-KEYBOARD-MX',
            unitPricePaise: '100000',
            quantity: 1,
            lineTotalPaise: '100000',
          },
          {
            sku: 'SKU-KEYBOARD-MX',
            unitPricePaise: '100000',
            quantity: 1,
            lineTotalPaise: '100000',
          },
        ],
        subtotalPaise: '200000',
        taxPaise: '0',
        shippingPaise: '0',
        discountPaise: '0',
        totalPaise: '200000',
      }),
    );
    expect(result.decision).toBe('block');
    expect(ruleIds(result)).toContain('QUANTITY_EXCEEDED');
  });

  it('blocks a line total that does not multiply out', () => {
    const result = check(
      quoteFixture({
        lineItems: [
          {
            sku: 'SKU-USBC-CABLE-2M',
            unitPricePaise: '50000',
            quantity: 2,
            lineTotalPaise: '50000', // should be 100000
          },
        ],
        subtotalPaise: '50000',
        taxPaise: '0',
        shippingPaise: '0',
        discountPaise: '0',
        totalPaise: '50000',
      }),
    );
    expect(ruleIds(result)).toContain('LINE_TOTAL_ARITHMETIC');
  });

  it('blocks a subtotal that does not match the lines', () => {
    const result = check(quoteFixture({ subtotalPaise: '270000' }));
    expect(ruleIds(result)).toContain('SUBTOTAL_ARITHMETIC');
  });

  it('blocks a total that does not match its components', () => {
    const result = check(quoteFixture({ totalPaise: '244800' }));
    expect(ruleIds(result)).toContain('TOTAL_ARITHMETIC');
  });

  it('blocks a zero-total quote', () => {
    const result = check(
      quoteFixture({
        discountPaise: '300000',
        totalPaise: '0',
      }),
    );
    expect(ruleIds(result)).toContain('ZERO_TOTAL');
  });

  it('blocks delivery promised outside the window', () => {
    const result = check(quoteFixture({ promisedDeliveryAt: '2026-09-20T00:00:00.000Z' }));
    expect(ruleIds(result)).toContain('DELIVERY_OUTSIDE_WINDOW');
  });

  it('blocks delivery promised before the window opens', () => {
    const result = check(quoteFixture({ promisedDeliveryAt: '2026-08-28T06:00:00.000Z' }));
    expect(ruleIds(result)).toContain('DELIVERY_OUTSIDE_WINDOW');
  });

  it('blocks an expired quote', () => {
    const result = check(quoteFixture({ quoteExpiresAt: '2026-08-28T11:00:00.000Z' }));
    expect(ruleIds(result)).toContain('QUOTE_EXPIRED');
  });

  it('blocks when this payment would breach the cumulative ceiling', () => {
    // ₹7,500 cumulative cap, ₹5,100 already spent, ₹2,449 more would exceed it.
    const result = check(quoteFixture(), { cumulativeAuthorizedPaise: 510_000n });
    expect(ruleIds(result)).toContain('CUMULATIVE_CEILING_EXCEEDED');
  });

  it('allows when cumulative spend lands exactly on the ceiling', () => {
    const result = check(quoteFixture(), { cumulativeAuthorizedPaise: 505_100n });
    expect(result.decision).toBe('allow');
  });

  it('reports every violation, not just the first', () => {
    const result = check(
      quoteFixture({
        merchantId: 'merchant_rogue',
        currency: 'INR',
        promisedDeliveryAt: '2026-10-01T00:00:00.000Z',
      }),
    );
    expect(ruleIds(result)).toEqual(
      expect.arrayContaining(['MERCHANT_NOT_ALLOWED', 'DELIVERY_OUTSIDE_WINDOW']),
    );
    expect(result.violations.length).toBeGreaterThanOrEqual(2);
  });
});

describe('fail-closed behaviour', () => {
  it('blocks a quote that does not parse at all', () => {
    const result = check({ nonsense: true } as unknown as StructuredQuoteInput);
    expect(result.decision).toBe('block');
    expect(ruleIds(result)).toContain('QUOTE_MALFORMED');
  });

  it('blocks a quote carrying an unexpected field', () => {
    const result = check({ ...quoteFixture(), surcharge: '99999' } as StructuredQuoteInput);
    expect(result.decision).toBe('block');
  });

  it('blocks a quote with a fractional price rather than rounding it', () => {
    const result = check(
      quoteFixture({
        lineItems: [
          {
            sku: 'SKU-KEYBOARD-MX',
            unitPricePaise: '1750.50' as unknown as string,
            quantity: 1,
            lineTotalPaise: '175050',
          },
        ],
      }),
    );
    expect(result.decision).toBe('block');
    expect(ruleIds(result)).toContain('QUOTE_MALFORMED');
  });

  it('never returns allow on a malformed quote, whatever the shape', () => {
    for (const bad of [null, undefined, 42, 'quote', [], {}]) {
      expect(check(bad as unknown as StructuredQuoteInput).decision).toBe('block');
    }
  });
});

describe('pre-capture re-check', () => {
  const authorizedQuote = quoteFixture();
  const authorizedHash = hashQuote(structuredQuoteSchema.parse(authorizedQuote));

  it('allows capture when nothing has changed', () => {
    const result = check(authorizedQuote, {
      stage: 'pre_capture',
      authorizedAmountPaise: 244_900n,
      authorizedQuoteHash: authorizedHash,
    });
    expect(result.decision).toBe('allow');
  });

  it('blocks capture when the amount moved after the hold', () => {
    const result = check(quoteFixture({ discountPaise: '50000', totalPaise: '250000' }), {
      stage: 'pre_capture',
      authorizedAmountPaise: 244_900n,
      authorizedQuoteHash: authorizedHash,
    });
    expect(ruleIds(result)).toContain('AMOUNT_CHANGED_SINCE_AUTHORIZATION');
  });

  it('blocks a same-price bait-and-switch after the hold', () => {
    // Identical total, different goods: two cables swapped for one keyboard.
    const swapped = quoteFixture({
      merchantQuoteRef: 'Q-88213-REV2',
      promisedDeliveryAt: '2026-09-04T00:00:00.000Z',
    });
    const result = check(swapped, {
      stage: 'pre_capture',
      authorizedAmountPaise: 244_900n,
      authorizedQuoteHash: authorizedHash,
    });
    expect(ruleIds(result)).toContain('QUOTE_CHANGED_SINCE_AUTHORIZATION');
    expect(ruleIds(result)).not.toContain('AMOUNT_CHANGED_SINCE_AUTHORIZATION');
  });

  it('does not run capture-only rules at authorization time', () => {
    const result = check(quoteFixture(), { stage: 'pre_authorization' });
    expect(ruleIds(result)).not.toContain('AMOUNT_CHANGED_SINCE_AUTHORIZATION');
    expect(ruleIds(result)).not.toContain('QUOTE_CHANGED_SINCE_AUTHORIZATION');
  });
});

describe('determinism', () => {
  it('gives the same verdict for the same inputs, every time', () => {
    const runs = Array.from({ length: 25 }, () => check(quoteFixture({ totalPaise: '244900' })));
    const first = JSON.stringify(runs[0]);
    expect(runs.every((r) => JSON.stringify(r) === first)).toBe(true);
  });

  it('is unaffected by key order in the incoming quote', () => {
    const normal = check(quoteFixture());
    const reordered = check(
      Object.fromEntries(
        Object.entries(quoteFixture()).reverse(),
      ) as unknown as StructuredQuoteInput,
    );
    expect(reordered.quoteHash).toBe(normal.quoteHash);
    expect(reordered.decision).toBe(normal.decision);
  });
});
