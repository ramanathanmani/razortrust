/**
 * The Mandate: the one artefact a human actually signs.
 *
 * Everything downstream — drift checks, capture, settlement — is an argument
 * about whether reality still matches this document. So the document has to be
 * complete, canonical, and hash-bound: `termsHash` is the SHA-256 of the
 * canonical form of `terms`, and the signature covers that hash. Change a
 * single paise of the ceiling and the hash moves, the signature breaks, and
 * every payment referencing it stops.
 */
import { z } from 'zod';

import { SUPPORTED_CURRENCIES } from '../money.js';

/**
 * Money on the wire is a decimal string of paise, so nothing hits a float.
 *
 * The schema must be IDEMPOTENT: `parse(parse(x))` has to succeed, because
 * verification re-parses already-parsed terms on every use. So bigint is
 * accepted on the way in as well as produced on the way out.
 */
export const paiseSchema = z
  .union([
    z.string().regex(/^\d+$/, 'Amount must be a non-negative integer string of paise'),
    z.bigint(),
  ])
  .transform((v) => (typeof v === 'string' ? BigInt(v) : v))
  .refine((v) => v >= 0n, 'Amount must not be negative');

export const isoInstantSchema = z
  .string()
  .datetime({ offset: false })
  .describe('UTC ISO-8601 instant, e.g. 2026-08-28T10:00:00.000Z');

/**
 * One line the agent is permitted to buy.
 *
 * A mandate lists SKUs explicitly. "Anything under ₹5000" is not a mandate,
 * it is a budget, and budgets are what let agents buy the wrong thing.
 */
export const allowedItemSchema = z
  .object({
    sku: z.string().min(1).max(128),
    /** Human label, carried for the audit trail. Not used in matching. */
    description: z.string().max(512).optional(),
    maxUnitPricePaise: paiseSchema,
    maxQuantity: z.number().int().positive().max(10_000),
  })
  .strict();

export type AllowedItem = z.output<typeof allowedItemSchema>;

export const deliveryWindowSchema = z
  .object({
    /** Earliest acceptable delivery. */
    startsAt: isoInstantSchema,
    /** Latest acceptable delivery. Missed windows drive settlement decisions. */
    endsAt: isoInstantSchema,
  })
  .strict()
  .refine((w) => Date.parse(w.startsAt) < Date.parse(w.endsAt), {
    message: 'Delivery window must start before it ends',
  });

export type DeliveryWindow = z.output<typeof deliveryWindowSchema>;

/**
 * The signed payload. Every field here is part of the hash.
 *
 * `nonce` makes two otherwise-identical mandates distinct documents, so a
 * signature captured from one can never be replayed onto the other.
 */
export const mandateTermsSchema = z
  .object({
    /** Bumped when the meaning of any field changes. Old mandates keep working. */
    version: z.literal(1),
    mandateId: z.string().uuid(),
    nonce: z.string().min(16).max(128),

    tenantId: z.string().min(1).max(64),
    principalId: z.string().min(1).max(64),
    /** The one agent allowed to spend against this mandate. */
    agentId: z.string().min(1).max(64),

    currency: z.enum(SUPPORTED_CURRENCIES),

    /** Ceiling for a single payment under this mandate, inclusive. */
    maxAmountPaise: paiseSchema,
    /**
     * Ceiling across every payment under this mandate, inclusive.
     * Defends against "many small purchases" as a way around maxAmountPaise.
     */
    maxCumulativeAmountPaise: paiseSchema,
    /** How many payments this mandate may authorize in total. */
    maxUses: z.number().int().positive().max(1000),

    allowedItems: z.array(allowedItemSchema).min(1).max(200),
    /** Merchant identity is matched exactly. No fuzzy matching, ever. */
    allowedMerchantIds: z.array(z.string().min(1).max(128)).min(1).max(50),

    deliveryWindow: deliveryWindowSchema,

    /** Mandate validity. Separate from the delivery window on purpose. */
    notBefore: isoInstantSchema,
    notAfter: isoInstantSchema,

    /**
     * How long an authorization may be held before capture, in hours.
     * Clamped to the Razorpay 3-day ceiling at authorization time.
     */
    captureDeadlineHours: z.number().int().positive().max(72),

    /** Whether RazorTrust may execute a refund the settlement engine recommends. */
    autoRefundAllowed: z.boolean(),

    /** Free-form human note. Hashed, so it cannot be edited after signing. */
    memo: z.string().max(1000).optional(),
  })
  .strict()
  .refine((t) => Date.parse(t.notBefore) < Date.parse(t.notAfter), {
    message: 'Mandate validity must start before it ends',
  })
  .refine((t) => t.maxCumulativeAmountPaise >= t.maxAmountPaise, {
    message: 'Cumulative ceiling cannot be lower than the single-payment ceiling',
  })
  // The drift engine indexes the allowlist by SKU. A duplicate would make one
  // entry silently shadow the other, so which ceiling applies would depend on
  // array order — reject it at signing time instead.
  .refine((t) => new Set(t.allowedItems.map((i) => i.sku)).size === t.allowedItems.length, {
    message: 'allowedItems must not contain duplicate SKUs',
    path: ['allowedItems'],
  });

export type MandateTerms = z.output<typeof mandateTermsSchema>;
/** Shape as it arrives over the wire, before paise strings become bigint. */
export type MandateTermsInput = z.input<typeof mandateTermsSchema>;

export const MANDATE_STATUSES = [
  'draft',
  'active',
  'revoked',
  'exhausted',
  'expired',
] as const;
export type MandateStatus = (typeof MANDATE_STATUSES)[number];

/** A mandate as stored: signed terms plus mutable bookkeeping. */
export interface SignedMandate {
  readonly terms: MandateTerms;
  readonly termsHash: string;
  readonly signature: string;
  readonly signedByPublicKeyPem: string;
  readonly signedAt: string;
}

/** Runtime state the rules engine consults alongside the signed terms. */
export interface MandateState {
  readonly status: MandateStatus;
  readonly usesCount: number;
  readonly cumulativeAuthorizedPaise: bigint;
  readonly revokedAt?: string;
}
