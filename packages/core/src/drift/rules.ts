/**
 * The drift rules.
 *
 * Each rule is a pure function from (mandate, quote, context) to violations.
 * They are listed in a table so the set is readable in one screen and testable
 * one at a time — which matters, because this table is the thing standing
 * between an agent and someone's money.
 *
 * Every rule is blocking. There is deliberately no severity dial: a "warning"
 * that lets a payment through is just a rule someone disabled.
 */
import { multiplyByQuantity, sum } from '../money.js';
import type { AllowedItem, MandateTerms } from '../mandate/types.js';
import type { DriftRuleId, DriftStage, DriftViolation, StructuredQuote } from './types.js';

/** Bump on ANY change to rule behaviour. Recorded with every verdict. */
export const RULES_VERSION = '2026-08-28.1';

export interface RuleContext {
  readonly stage: DriftStage;
  readonly now: Date;
  /** Already authorized under this mandate, excluding the current quote. */
  readonly cumulativeAuthorizedPaise: bigint;
  /** At pre_capture: what was actually held, and the quote it was held for. */
  readonly authorizedAmountPaise?: bigint;
  readonly authorizedQuoteHash?: string;
  /** At pre_capture: hash of the quote now being presented. */
  readonly currentQuoteHash?: string;
}

export interface DriftRule {
  readonly id: DriftRuleId;
  readonly description: string;
  /** Stages this rule runs in. */
  readonly stages: readonly DriftStage[];
  readonly evaluate: (
    mandate: MandateTerms,
    quote: StructuredQuote,
    ctx: RuleContext,
  ) => DriftViolation[];
}

const BOTH_STAGES = ['pre_authorization', 'pre_capture'] as const;

/** Index the mandate's allowlist by SKU. Uniqueness is a schema invariant. */
function allowedBySku(mandate: MandateTerms): Map<string, AllowedItem> {
  return new Map(mandate.allowedItems.map((item) => [item.sku, item]));
}

/**
 * Total quantity per SKU across the whole quote.
 *
 * Aggregating matters: an agent that splits 3 units across three lines of 1
 * would slip past a naive per-line quantity check. The mandate said one
 * keyboard, and one keyboard is what the total has to be.
 */
function quantityBySku(quote: StructuredQuote): Map<string, number> {
  const totals = new Map<string, number>();
  for (const line of quote.lineItems) {
    totals.set(line.sku, (totals.get(line.sku) ?? 0) + line.quantity);
  }
  return totals;
}

export const DRIFT_RULES: readonly DriftRule[] = [
  {
    id: 'CURRENCY_MISMATCH',
    description: 'The quote must be denominated in the mandate’s currency.',
    stages: BOTH_STAGES,
    evaluate: (mandate, quote) =>
      quote.currency === mandate.currency
        ? []
        : [
            {
              ruleId: 'CURRENCY_MISMATCH',
              message: `Quote is in ${quote.currency}, mandate authorises ${mandate.currency}`,
              path: 'currency',
              expected: mandate.currency,
              actual: quote.currency,
            },
          ],
  },

  {
    id: 'MERCHANT_NOT_ALLOWED',
    description: 'The merchant must appear in the mandate allowlist, matched exactly.',
    stages: BOTH_STAGES,
    evaluate: (mandate, quote) =>
      mandate.allowedMerchantIds.includes(quote.merchantId)
        ? []
        : [
            {
              ruleId: 'MERCHANT_NOT_ALLOWED',
              message: `Merchant "${quote.merchantId}" is not on this mandate`,
              path: 'merchantId',
              expected: mandate.allowedMerchantIds.join(', '),
              actual: quote.merchantId,
            },
          ],
  },

  {
    id: 'SKU_NOT_ALLOWED',
    description: 'Every line item must be a SKU the human approved.',
    stages: BOTH_STAGES,
    evaluate: (mandate, quote) => {
      const allowed = allowedBySku(mandate);
      return quote.lineItems.flatMap((line, i) =>
        allowed.has(line.sku)
          ? []
          : [
              {
                ruleId: 'SKU_NOT_ALLOWED' as const,
                message: `SKU "${line.sku}" is not on this mandate`,
                path: `lineItems[${i}].sku`,
                expected: [...allowed.keys()].join(', '),
                actual: line.sku,
              },
            ],
      );
    },
  },

  {
    id: 'UNIT_PRICE_EXCEEDED',
    description: 'No line may exceed the per-item price ceiling for its SKU.',
    stages: BOTH_STAGES,
    evaluate: (mandate, quote) => {
      const allowed = allowedBySku(mandate);
      return quote.lineItems.flatMap((line, i) => {
        const cap = allowed.get(line.sku);
        // An unknown SKU is already reported by SKU_NOT_ALLOWED; reporting it
        // twice adds noise without adding information.
        if (!cap || line.unitPricePaise <= cap.maxUnitPricePaise) return [];
        return [
          {
            ruleId: 'UNIT_PRICE_EXCEEDED' as const,
            message: `Unit price for "${line.sku}" is above the approved ceiling`,
            path: `lineItems[${i}].unitPricePaise`,
            expected: cap.maxUnitPricePaise.toString(),
            actual: line.unitPricePaise.toString(),
          },
        ];
      });
    },
  },

  {
    id: 'QUANTITY_EXCEEDED',
    description: 'Total quantity per SKU, summed across lines, must fit the mandate.',
    stages: BOTH_STAGES,
    evaluate: (mandate, quote) => {
      const allowed = allowedBySku(mandate);
      const totals = quantityBySku(quote);
      const violations: DriftViolation[] = [];
      for (const [sku, qty] of totals) {
        const cap = allowed.get(sku);
        if (!cap || qty <= cap.maxQuantity) continue;
        violations.push({
          ruleId: 'QUANTITY_EXCEEDED',
          message: `Quote asks for ${qty} of "${sku}" across all lines; mandate allows ${cap.maxQuantity}`,
          path: `lineItems[sku=${sku}].quantity`,
          expected: String(cap.maxQuantity),
          actual: String(qty),
        });
      }
      return violations;
    },
  },

  {
    id: 'LINE_TOTAL_ARITHMETIC',
    description: 'Each line total must equal unit price times quantity.',
    stages: BOTH_STAGES,
    evaluate: (_mandate, quote) =>
      quote.lineItems.flatMap((line, i) => {
        const expected = multiplyByQuantity(line.unitPricePaise, line.quantity);
        return line.lineTotalPaise === expected
          ? []
          : [
              {
                ruleId: 'LINE_TOTAL_ARITHMETIC' as const,
                message: `Line total for "${line.sku}" does not equal unit price × quantity`,
                path: `lineItems[${i}].lineTotalPaise`,
                expected: expected.toString(),
                actual: line.lineTotalPaise.toString(),
              },
            ];
      }),
  },

  {
    id: 'SUBTOTAL_ARITHMETIC',
    description: 'Subtotal must equal the sum of the line totals.',
    stages: BOTH_STAGES,
    evaluate: (_mandate, quote) => {
      const expected = sum(quote.lineItems.map((l) => l.lineTotalPaise));
      return quote.subtotalPaise === expected
        ? []
        : [
            {
              ruleId: 'SUBTOTAL_ARITHMETIC',
              message: 'Subtotal does not equal the sum of the line totals',
              path: 'subtotalPaise',
              expected: expected.toString(),
              actual: quote.subtotalPaise.toString(),
            },
          ];
    },
  },

  {
    id: 'TOTAL_ARITHMETIC',
    description: 'Total must equal subtotal + tax + shipping − discount.',
    stages: BOTH_STAGES,
    evaluate: (_mandate, quote) => {
      // Computed in bigint, so there is no rounding to argue about. A discount
      // larger than the rest is caught here as a mismatch rather than by
      // clamping to zero and quietly accepting a nonsense quote.
      const expected =
        quote.subtotalPaise + quote.taxPaise + quote.shippingPaise - quote.discountPaise;
      return quote.totalPaise === expected
        ? []
        : [
            {
              ruleId: 'TOTAL_ARITHMETIC',
              message: 'Total does not equal subtotal + tax + shipping − discount',
              path: 'totalPaise',
              expected: expected.toString(),
              actual: quote.totalPaise.toString(),
            },
          ];
    },
  },

  {
    id: 'ZERO_TOTAL',
    description: 'A payable quote must charge something.',
    stages: BOTH_STAGES,
    evaluate: (_mandate, quote) =>
      quote.totalPaise > 0n
        ? []
        : [
            {
              ruleId: 'ZERO_TOTAL',
              message: 'Quote total is zero; there is nothing to authorise',
              path: 'totalPaise',
              expected: '> 0',
              actual: quote.totalPaise.toString(),
            },
          ],
  },

  {
    id: 'TOTAL_EXCEEDS_MANDATE_CEILING',
    description: 'The total must not exceed the single-payment ceiling.',
    stages: BOTH_STAGES,
    evaluate: (mandate, quote) =>
      quote.totalPaise <= mandate.maxAmountPaise
        ? []
        : [
            {
              ruleId: 'TOTAL_EXCEEDS_MANDATE_CEILING',
              message: 'Quote total is above the approved price ceiling',
              path: 'totalPaise',
              expected: mandate.maxAmountPaise.toString(),
              actual: quote.totalPaise.toString(),
            },
          ],
  },

  {
    id: 'CUMULATIVE_CEILING_EXCEEDED',
    description: 'Spend so far plus this quote must fit the cumulative ceiling.',
    stages: BOTH_STAGES,
    evaluate: (mandate, quote, ctx) => {
      const projected = ctx.cumulativeAuthorizedPaise + quote.totalPaise;
      return projected <= mandate.maxCumulativeAmountPaise
        ? []
        : [
            {
              ruleId: 'CUMULATIVE_CEILING_EXCEEDED',
              message: 'This payment would push cumulative spend past the mandate ceiling',
              path: 'totalPaise',
              expected: mandate.maxCumulativeAmountPaise.toString(),
              actual: projected.toString(),
            },
          ];
    },
  },

  {
    id: 'DELIVERY_OUTSIDE_WINDOW',
    description: 'Promised delivery must fall inside the approved window.',
    stages: BOTH_STAGES,
    evaluate: (mandate, quote) => {
      const promised = Date.parse(quote.promisedDeliveryAt);
      const start = Date.parse(mandate.deliveryWindow.startsAt);
      const end = Date.parse(mandate.deliveryWindow.endsAt);
      return promised >= start && promised <= end
        ? []
        : [
            {
              ruleId: 'DELIVERY_OUTSIDE_WINDOW',
              message: 'Promised delivery falls outside the approved delivery window',
              path: 'promisedDeliveryAt',
              expected: `${mandate.deliveryWindow.startsAt} .. ${mandate.deliveryWindow.endsAt}`,
              actual: quote.promisedDeliveryAt,
            },
          ];
    },
  },

  {
    id: 'DELIVERY_AFTER_MANDATE_EXPIRY',
    description: 'Delivery must not be promised after the mandate itself expires.',
    stages: BOTH_STAGES,
    evaluate: (mandate, quote) =>
      // Otherwise the goods arrive with no live mandate to settle them against,
      // and the post-delivery rules have nothing to compare to.
      Date.parse(quote.promisedDeliveryAt) <= Date.parse(mandate.notAfter)
        ? []
        : [
            {
              ruleId: 'DELIVERY_AFTER_MANDATE_EXPIRY',
              message: 'Delivery is promised after the mandate expires',
              path: 'promisedDeliveryAt',
              expected: mandate.notAfter,
              actual: quote.promisedDeliveryAt,
            },
          ],
  },

  {
    id: 'QUOTE_EXPIRED',
    description: 'A quote past its own expiry is not a final quote.',
    stages: BOTH_STAGES,
    evaluate: (_mandate, quote, ctx) => {
      if (!quote.quoteExpiresAt) return [];
      return Date.parse(quote.quoteExpiresAt) >= ctx.now.getTime()
        ? []
        : [
            {
              ruleId: 'QUOTE_EXPIRED',
              message: 'Quote has expired; re-fetch it from the merchant',
              path: 'quoteExpiresAt',
              expected: `>= ${ctx.now.toISOString()}`,
              actual: quote.quoteExpiresAt,
            },
          ];
    },
  },

  {
    id: 'AMOUNT_CHANGED_SINCE_AUTHORIZATION',
    description: 'At capture, the amount must still match what was held.',
    stages: ['pre_capture'],
    evaluate: (_mandate, quote, ctx) => {
      if (ctx.authorizedAmountPaise === undefined) return [];
      return quote.totalPaise === ctx.authorizedAmountPaise
        ? []
        : [
            {
              ruleId: 'AMOUNT_CHANGED_SINCE_AUTHORIZATION',
              message: 'Amount changed between authorization and capture',
              path: 'totalPaise',
              expected: ctx.authorizedAmountPaise.toString(),
              actual: quote.totalPaise.toString(),
            },
          ];
    },
  },

  {
    id: 'QUOTE_CHANGED_SINCE_AUTHORIZATION',
    description: 'At capture, the quote must be byte-identical to the one authorized.',
    stages: ['pre_capture'],
    evaluate: (_mandate, _quote, ctx) => {
      // The amount check above catches a price change. This catches everything
      // else — a swapped SKU, a moved delivery date, a different merchant
      // reference — at the same total.
      if (!ctx.authorizedQuoteHash || !ctx.currentQuoteHash) return [];
      return ctx.currentQuoteHash === ctx.authorizedQuoteHash
        ? []
        : [
            {
              ruleId: 'QUOTE_CHANGED_SINCE_AUTHORIZATION',
              message: 'Quote contents changed between authorization and capture',
              path: 'quoteHash',
              expected: ctx.authorizedQuoteHash,
              actual: ctx.currentQuoteHash,
            },
          ];
    },
  },
];

export function rulesForStage(stage: DriftStage): readonly DriftRule[] {
  return DRIFT_RULES.filter((rule) => rule.stages.includes(stage));
}
