/**
 * What the model is allowed to produce.
 *
 * This schema is NOT the schema a quote is judged against. It is a candidate
 * shape: flat, JSON-schema friendly, every number a string, and every figure
 * accompanied by the literal text it was read from. The candidate is then fed
 * through `structuredQuoteSchema` — the exact same schema a merchant API's
 * response hits — and rejected outright if it does not fit.
 *
 * The model gets no second attempt and no repair pass. A quote it could not
 * read correctly is a quote nobody pays.
 */
import { z } from 'zod';

/**
 * A figure the model claims to have read, plus proof.
 *
 * `sourceExcerpt` must be a literal substring of the input. That turns "did the
 * model invent this number?" from a question about model behaviour into a
 * string comparison plain code can run — see verify.ts.
 */
export const extractedLineItemSchema = z
  .object({
    sku: z.string(),
    description: z.string().nullable(),
    /** Integer paise, as a string. */
    unitPricePaise: z.string(),
    quantity: z.number().int(),
    lineTotalPaise: z.string(),
    /** Verbatim text this line's price was read from. */
    sourceExcerpt: z.string(),
  })
  .strict();

export const extractedQuoteSchema = z
  .object({
    /**
     * Set true when the input is unreadable, ambiguous, or missing figures.
     * Abstaining is always correct where guessing is the alternative.
     */
    abstained: z.boolean(),
    abstainReason: z.string().nullable(),

    currency: z.string(),
    merchantQuoteRef: z.string().nullable(),

    lineItems: z.array(extractedLineItemSchema),

    subtotalPaise: z.string(),
    taxPaise: z.string(),
    shippingPaise: z.string(),
    discountPaise: z.string(),
    totalPaise: z.string(),
    /** Verbatim text the total was read from. */
    totalSourceExcerpt: z.string(),

    /** ISO-8601 UTC. */
    promisedDeliveryAt: z.string(),
    quoteExpiresAt: z.string().nullable(),

    /**
     * The model's own confidence, 0-100.
     *
     * Advisory only. It is recorded for the audit trail and NEVER gates a
     * payment — a confident wrong answer and an unconfident wrong answer are
     * equally wrong, and the deterministic checks catch both.
     */
    confidence: z.number().int(),
  })
  .strict();

export type ExtractedQuote = z.infer<typeof extractedQuoteSchema>;

export const STRUCTURING_REJECTION_CODES = [
  'MODEL_ABSTAINED',
  'MODEL_REFUSED',
  'SCHEMA_MISMATCH',
  'UNGROUNDED_FIGURE',
  'NOT_VALID_QUOTE',
  'EMPTY_INPUT',
  'MODEL_ERROR',
] as const;
export type StructuringRejectionCode = (typeof STRUCTURING_REJECTION_CODES)[number];

export interface StructuringRejection {
  readonly code: StructuringRejectionCode;
  readonly message: string;
  readonly detail?: readonly string[];
}

/**
 * The adapter's result.
 *
 * Note there is no partial success. Either a fully valid StructuredQuote came
 * out — one the drift engine can judge exactly as it would a merchant API's —
 * or the attempt is rejected with a reason.
 */
export type StructuringResult =
  | {
      readonly ok: true;
      /** Already validated against structuredQuoteSchema. */
      readonly quote: unknown;
      readonly model: string;
      readonly confidence: number;
      readonly usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
    }
  | {
      readonly ok: false;
      readonly rejection: StructuringRejection;
      readonly model: string;
      readonly rawModelOutput?: unknown;
    };

export interface StructureQuoteArgs {
  /** The messy thing: an email body, an HTML invoice, a chat transcript. */
  readonly rawInput: string;
  /**
   * Merchant identity from OUR records.
   *
   * Deliberately not extracted by the model. Who the merchant is decides
   * whether the mandate permits the purchase at all, so it comes from the
   * database rather than from text a merchant controls.
   */
  readonly merchantId: string;
  /** Our clock, not the model's. */
  readonly now: Date;
}

/** Both the live structurer and the fake implement this. */
export interface QuoteStructurer {
  readonly name: 'anthropic' | 'fake';
  structureQuote(args: StructureQuoteArgs): Promise<StructuringResult>;
}
