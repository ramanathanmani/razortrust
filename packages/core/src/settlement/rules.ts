/**
 * Post-delivery settlement rules.
 *
 * Same discipline as the drift engine: a table of pure functions, no scoring,
 * no model in the loop. The difference is that a settlement rule may legitimately
 * conclude "a human has to look at this", and saying so is a real answer rather
 * than a cop-out. A rules engine that always produces a number is one that
 * guesses about somebody's money.
 */
import type { MandateTerms } from '../mandate/types.js';
import type { StructuredQuote } from '../drift/types.js';
import { multiplyByQuantity, min } from '../money.js';
import type { DeliveryEvidence, SettlementReason } from './types.js';

/** Bump on ANY change to rule behaviour. Recorded with every recommendation. */
export const SETTLEMENT_RULES_VERSION = '2026-08-28.1';

export interface SettlementContext {
  readonly now: Date;
  /** What was actually captured. Refunds can never exceed this. */
  readonly capturedAmountPaise: bigint;
  readonly alreadyRefundedPaise: bigint;
}

export interface SettlementRule {
  readonly id: string;
  readonly description: string;
  readonly evaluate: (args: {
    mandate: MandateTerms;
    quote: StructuredQuote;
    evidence: DeliveryEvidence;
    ctx: SettlementContext;
  }) => SettlementReason[];
}

/** Unit price per SKU, from the quote that was actually paid for. */
function unitPriceBySku(quote: StructuredQuote): Map<string, bigint> {
  const prices = new Map<string, bigint>();
  for (const line of quote.lineItems) prices.set(line.sku, line.unitPricePaise);
  return prices;
}

function quotedQuantityBySku(quote: StructuredQuote): Map<string, number> {
  const totals = new Map<string, number>();
  for (const line of quote.lineItems) {
    totals.set(line.sku, (totals.get(line.sku) ?? 0) + line.quantity);
  }
  return totals;
}

function deliveredQuantityBySku(evidence: DeliveryEvidence): Map<string, number> {
  const totals = new Map<string, number>();
  for (const item of evidence.lineItems) {
    // Damaged and missing units did not arrive in any useful sense. They are
    // counted separately by their own rules, not as delivered.
    if (item.condition !== 'good') continue;
    totals.set(item.sku, (totals.get(item.sku) ?? 0) + item.quantity);
  }
  return totals;
}

export const SETTLEMENT_RULES: readonly SettlementRule[] = [
  {
    id: 'delivery-outcome',
    description: 'The delivery either happened or it did not.',
    evaluate: ({ evidence }) => {
      switch (evidence.status) {
        case 'failed':
          return [
            {
              ruleId: 'DELIVERY_FAILED',
              verdict: 'full_refund',
              message: 'Carrier reports the delivery failed; nothing was received',
            },
          ];
        case 'returned':
          return [
            {
              ruleId: 'RETURNED',
              verdict: 'full_refund',
              message: 'The order was returned to the merchant',
            },
          ];
        case 'lost':
          return [
            {
              ruleId: 'LOST_IN_TRANSIT',
              verdict: 'full_refund',
              message: 'The shipment was lost in transit',
            },
          ];
        case 'in_transit':
          return [
            {
              ruleId: 'STILL_IN_TRANSIT',
              verdict: 'none',
              message: 'Still in transit; there is nothing to settle yet',
            },
          ];
        case 'delivered':
          return [];
        default:
          return [];
      }
    },
  },

  {
    id: 'delivery-window',
    description: 'Delivery must land inside the window the human approved.',
    evaluate: ({ mandate, evidence }) => {
      if (evidence.status !== 'delivered' || !evidence.deliveredAt) return [];

      const delivered = Date.parse(evidence.deliveredAt);
      const start = Date.parse(mandate.deliveryWindow.startsAt);
      const end = Date.parse(mandate.deliveryWindow.endsAt);

      if (delivered > end) {
        // Late, but the goods did arrive. Whether lateness is worth money back
        // depends on why it mattered, and only a human knows that.
        return [
          {
            ruleId: 'DELIVERED_AFTER_WINDOW',
            verdict: 'escalate',
            message: 'Delivered after the approved window; a human should decide on compensation',
            expected: mandate.deliveryWindow.endsAt,
            actual: evidence.deliveredAt,
          },
        ];
      }
      if (delivered < start) {
        return [
          {
            ruleId: 'DELIVERED_BEFORE_WINDOW',
            verdict: 'escalate',
            message: 'Delivered before the approved window opened',
            expected: mandate.deliveryWindow.startsAt,
            actual: evidence.deliveredAt,
          },
        ];
      }
      return [];
    },
  },

  {
    id: 'evidence-coherence',
    description: 'The evidence must not contradict itself.',
    evaluate: ({ evidence, ctx }) => {
      const reasons: SettlementReason[] = [];

      if (evidence.status === 'delivered' && !evidence.deliveredAt) {
        reasons.push({
          ruleId: 'MISSING_DELIVERY_TIMESTAMP',
          verdict: 'escalate',
          message: 'Marked delivered but carries no delivery timestamp',
        });
      }

      if (evidence.status === 'delivered' && !evidence.trackingId && !evidence.proofOfDeliveryRef) {
        // "Trust me, it arrived" is not evidence.
        reasons.push({
          ruleId: 'NO_TRACKING_EVIDENCE',
          verdict: 'escalate',
          message: 'Marked delivered with neither a tracking id nor proof of delivery',
        });
      }

      if (evidence.shippedAt && evidence.deliveredAt) {
        if (Date.parse(evidence.deliveredAt) < Date.parse(evidence.shippedAt)) {
          reasons.push({
            ruleId: 'DELIVERED_BEFORE_SHIPPED',
            verdict: 'escalate',
            message: 'Delivery timestamp precedes the shipping timestamp',
            expected: `>= ${evidence.shippedAt}`,
            actual: evidence.deliveredAt,
          });
        }
      }

      for (const [label, value] of [
        ['shippedAt', evidence.shippedAt],
        ['deliveredAt', evidence.deliveredAt],
      ] as const) {
        if (value && Date.parse(value) > ctx.now.getTime()) {
          reasons.push({
            ruleId: 'TIMESTAMP_IN_FUTURE',
            verdict: 'escalate',
            message: `${label} is in the future`,
            expected: `<= ${ctx.now.toISOString()}`,
            actual: value,
          });
        }
      }

      return reasons;
    },
  },

  {
    id: 'line-item-reconciliation',
    description: 'Every line paid for must have arrived, in the right quantity.',
    evaluate: ({ quote, evidence }) => {
      if (evidence.status !== 'delivered') return [];

      const prices = unitPriceBySku(quote);
      const quoted = quotedQuantityBySku(quote);
      const delivered = deliveredQuantityBySku(evidence);
      const reasons: SettlementReason[] = [];

      for (const [sku, quotedQty] of quoted) {
        const deliveredQty = delivered.get(sku) ?? 0;
        if (deliveredQty >= quotedQty) continue;

        const unitPrice = prices.get(sku) ?? 0n;
        const shortfall = quotedQty - deliveredQty;
        const owed = multiplyByQuantity(unitPrice, shortfall);

        reasons.push(
          deliveredQty === 0
            ? {
                ruleId: 'ITEM_NOT_DELIVERED',
                verdict: 'partial_refund',
                message: `Nothing was delivered for "${sku}"`,
                sku,
                refundAmountPaise: owed.toString(),
                expected: String(quotedQty),
                actual: '0',
              }
            : {
                ruleId: 'SHORT_QUANTITY',
                verdict: 'partial_refund',
                message: `Short by ${shortfall} unit(s) of "${sku}"`,
                sku,
                refundAmountPaise: owed.toString(),
                expected: String(quotedQty),
                actual: String(deliveredQty),
              },
        );
      }

      return reasons;
    },
  },

  {
    id: 'damaged-goods',
    description: 'Damaged units are refundable at what was paid for them.',
    evaluate: ({ quote, evidence }) => {
      if (evidence.status !== 'delivered') return [];

      const prices = unitPriceBySku(quote);
      const reasons: SettlementReason[] = [];

      for (const item of evidence.lineItems) {
        if (item.condition !== 'damaged' || item.quantity === 0) continue;
        const unitPrice = prices.get(item.sku);
        // A damaged SKU we never paid for is a different problem entirely.
        if (unitPrice === undefined) continue;

        reasons.push({
          ruleId: 'ITEM_DAMAGED',
          verdict: 'partial_refund',
          message: `${item.quantity} unit(s) of "${item.sku}" arrived damaged`,
          sku: item.sku,
          refundAmountPaise: multiplyByQuantity(unitPrice, item.quantity).toString(),
        });
      }

      return reasons;
    },
  },

  {
    id: 'unexpected-goods',
    description: 'Something arrived that was never quoted.',
    evaluate: ({ quote, evidence }) => {
      if (evidence.status !== 'delivered') return [];

      const quoted = new Set(quote.lineItems.map((l) => l.sku));
      const unexpected = evidence.lineItems.filter((i) => !quoted.has(i.sku) && i.quantity > 0);
      if (unexpected.length === 0) return [];

      // We did not pay for it, so there is no amount to compute. It may be a
      // merchant error, a substitution, or a mis-scan — all human questions.
      return [
        {
          ruleId: 'WRONG_SKU_DELIVERED',
          verdict: 'escalate',
          message: `Received item(s) that were never quoted: ${unexpected.map((i) => i.sku).join(', ')}`,
          actual: unexpected.map((i) => i.sku).join(', '),
        },
      ];
    },
  },

  {
    id: 'nothing-of-value',
    description: 'A delivery where none of the paid-for goods arrived is a full refund.',
    evaluate: ({ quote, evidence }) => {
      if (evidence.status !== 'delivered') return [];

      const quoted = quotedQuantityBySku(quote);
      const delivered = deliveredQuantityBySku(evidence);
      if (quoted.size === 0) return [];

      const anyArrived = [...quoted.keys()].some((sku) => (delivered.get(sku) ?? 0) > 0);
      if (anyArrived) return [];

      // Marked delivered, but nothing on the invoice actually turned up. The
      // per-line rules would already add up to the full amount; saying it once,
      // plainly, is clearer for whoever reads the audit log.
      return [
        {
          ruleId: 'NOTHING_OF_VALUE_DELIVERED',
          verdict: 'full_refund',
          message: 'Marked delivered, but none of the paid-for items arrived in good condition',
        },
      ];
    },
  },
];

/**
 * Cap a computed refund at what is actually refundable.
 *
 * Arithmetic on evidence can legitimately exceed the captured amount — several
 * rules can name the same money — and refunding more than was captured is not
 * a rounding problem, it is theft in the other direction.
 */
export function capRefund(amount: bigint, ctx: SettlementContext): bigint {
  const refundable = ctx.capturedAmountPaise - ctx.alreadyRefundedPaise;
  if (refundable <= 0n) return 0n;
  return min(amount, refundable);
}
