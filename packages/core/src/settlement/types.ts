/**
 * Post-delivery evidence, and the shape of a settlement recommendation.
 *
 * The engine compares what actually arrived against what the human approved
 * and what the merchant quoted. It produces a RECOMMENDATION — never an
 * action. Executing it is a separate, gated call, because moving money back is
 * still moving money.
 */
import { z } from 'zod';

import { isoInstantSchema } from '../mandate/types.js';

export const DELIVERY_STATUSES = [
  'in_transit',
  'delivered',
  'failed',
  'returned',
  'lost',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** What actually turned up, line by line. */
export const deliveredItemSchema = z
  .object({
    sku: z.string().min(1).max(128),
    description: z.string().max(512).optional(),
    quantity: z.number().int().nonnegative().max(10_000),
    /** Condition as reported by the carrier or merchant. */
    condition: z.enum(['good', 'damaged', 'missing']).default('good'),
  })
  .strict();

export type DeliveredItem = z.output<typeof deliveredItemSchema>;

export const deliveryEvidenceSchema = z
  .object({
    evidenceVersion: z.literal(1),
    status: z.enum(DELIVERY_STATUSES),

    trackingId: z.string().max(128).optional(),
    carrier: z.string().max(128).optional(),

    shippedAt: isoInstantSchema.optional(),
    deliveredAt: isoInstantSchema.optional(),

    lineItems: z.array(deliveredItemSchema).max(200).default([]),

    /** Proof-of-delivery reference, photo id, signature name, etc. */
    proofOfDeliveryRef: z.string().max(256).optional(),
  })
  .strict();

export type DeliveryEvidence = z.output<typeof deliveryEvidenceSchema>;
export type DeliveryEvidenceInput = z.input<typeof deliveryEvidenceSchema>;

export const SETTLEMENT_RULE_IDS = [
  'EVIDENCE_MALFORMED',
  'NOT_CAPTURED',
  'NEVER_DELIVERED',
  'DELIVERY_FAILED',
  'RETURNED',
  'LOST_IN_TRANSIT',
  'STILL_IN_TRANSIT',
  'NO_TRACKING_EVIDENCE',
  'MISSING_DELIVERY_TIMESTAMP',
  'DELIVERED_BEFORE_SHIPPED',
  'TIMESTAMP_IN_FUTURE',
  'DELIVERED_AFTER_WINDOW',
  'DELIVERED_BEFORE_WINDOW',
  'ITEM_NOT_DELIVERED',
  'SHORT_QUANTITY',
  'ITEM_DAMAGED',
  'WRONG_SKU_DELIVERED',
  'NOTHING_OF_VALUE_DELIVERED',
] as const;
export type SettlementRuleId = (typeof SETTLEMENT_RULE_IDS)[number];

/**
 * What a rule concluded.
 *
 * `escalate` is not a failure of the engine — it is the honest answer when the
 * evidence is contradictory or the judgement is genuinely a human's to make.
 * A rules engine that always produces a number is one that guesses.
 */
export type SettlementVerdict = 'none' | 'partial_refund' | 'full_refund' | 'escalate';

export interface SettlementReason {
  readonly ruleId: SettlementRuleId;
  readonly verdict: SettlementVerdict;
  readonly message: string;
  readonly sku?: string;
  /** Money this reason alone would give back, in paise. */
  readonly refundAmountPaise?: string;
  readonly expected?: string;
  readonly actual?: string;
}

export interface SettlementResult {
  readonly recommendation: SettlementVerdict;
  readonly refundAmountPaise: bigint;
  readonly reasons: readonly SettlementReason[];
  readonly rulesVersion: string;
  readonly evaluatedAt: string;
  /** True when the mandate permits RazorTrust to execute this without a human. */
  readonly autoExecutable: boolean;
}
