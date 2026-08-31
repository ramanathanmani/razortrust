/**
 * The structured quote, and the shape of a drift verdict.
 *
 * A StructuredQuote is the merchant's FINAL offer, normalised. It may arrive
 * from a merchant API (trusted) or from the AI structuring adapter (messy text
 * the model shaped, then validated here). Either way it lands in the same
 * schema and gets the same treatment — the source is recorded for the audit
 * trail, never used to relax a rule.
 */
import { z } from 'zod';

import { isoInstantSchema, paiseSchema } from '../mandate/types.js';
import { SUPPORTED_CURRENCIES } from '../money.js';

export const quoteLineItemSchema = z
  .object({
    sku: z.string().min(1).max(128),
    description: z.string().max(512).optional(),
    unitPricePaise: paiseSchema,
    quantity: z.number().int().positive().max(10_000),
    /**
     * The merchant's own line total. Recomputed and compared rather than
     * trusted — a line that does not multiply out is drift, and it is exactly
     * the kind of thing a sloppy or hostile quote gets wrong.
     */
    lineTotalPaise: paiseSchema,
  })
  .strict();

export type QuoteLineItem = z.output<typeof quoteLineItemSchema>;

export const structuredQuoteSchema = z
  .object({
    quoteVersion: z.literal(1),
    /** Matched EXACTLY against the mandate's merchant allowlist. */
    merchantId: z.string().min(1).max(128),
    merchantName: z.string().max(256).optional(),
    /** The merchant's own reference, carried for reconciliation. */
    merchantQuoteRef: z.string().max(128).optional(),

    currency: z.enum(SUPPORTED_CURRENCIES),

    lineItems: z.array(quoteLineItemSchema).min(1).max(200),

    subtotalPaise: paiseSchema,
    taxPaise: paiseSchema,
    shippingPaise: paiseSchema,
    discountPaise: paiseSchema,
    /** What the agent would actually be charged. */
    totalPaise: paiseSchema,

    /** When the merchant commits to delivering. Checked against the window. */
    promisedDeliveryAt: isoInstantSchema,
    /** After this, the quote is stale and must be re-fetched. */
    quoteExpiresAt: isoInstantSchema.optional(),

    capturedAt: isoInstantSchema,
  })
  .strict();

export type StructuredQuote = z.output<typeof structuredQuoteSchema>;
export type StructuredQuoteInput = z.input<typeof structuredQuoteSchema>;

/** Where in the flow a check ran. Some rules only apply at capture. */
export const DRIFT_STAGES = ['pre_authorization', 'pre_capture'] as const;
export type DriftStage = (typeof DRIFT_STAGES)[number];

export const DRIFT_RULE_IDS = [
  'QUOTE_MALFORMED',
  'CURRENCY_MISMATCH',
  'MERCHANT_NOT_ALLOWED',
  'SKU_NOT_ALLOWED',
  'UNIT_PRICE_EXCEEDED',
  'QUANTITY_EXCEEDED',
  'LINE_TOTAL_ARITHMETIC',
  'SUBTOTAL_ARITHMETIC',
  'TOTAL_ARITHMETIC',
  'ZERO_TOTAL',
  'TOTAL_EXCEEDS_MANDATE_CEILING',
  'CUMULATIVE_CEILING_EXCEEDED',
  'DELIVERY_OUTSIDE_WINDOW',
  'DELIVERY_AFTER_MANDATE_EXPIRY',
  'QUOTE_EXPIRED',
  'AMOUNT_CHANGED_SINCE_AUTHORIZATION',
  'QUOTE_CHANGED_SINCE_AUTHORIZATION',
] as const;
export type DriftRuleId = (typeof DRIFT_RULE_IDS)[number];

export interface DriftViolation {
  readonly ruleId: DriftRuleId;
  readonly message: string;
  /** Which part of the quote tripped it, e.g. `lineItems[2].unitPricePaise`. */
  readonly path?: string;
  /** What the mandate permitted. Strings so bigints survive serialisation. */
  readonly expected?: string;
  /** What the quote actually said. */
  readonly actual?: string;
}

/**
 * A verdict.
 *
 * There is no score, no threshold, and no "probably fine". Any violation
 * blocks. A human wrote the ceiling down; the engine's only job is to say
 * whether reality matches it.
 */
export type DriftDecision = 'allow' | 'block';

export interface DriftResult {
  readonly decision: DriftDecision;
  readonly violations: readonly DriftViolation[];
  readonly rulesVersion: string;
  readonly stage: DriftStage;
  /** sha256 of the canonical quote — ties this verdict to exact bytes. */
  readonly quoteHash: string;
  readonly evaluatedAt: string;
}
