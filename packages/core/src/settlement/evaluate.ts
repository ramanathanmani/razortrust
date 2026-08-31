/**
 * The settlement decision.
 *
 * Produces a RECOMMENDATION and an amount. It never moves money — executing is
 * a separate, gated call, and `autoExecutable` only says whether the mandate
 * permits skipping the human, not whether anything should happen now.
 *
 * Precedence between conflicting verdicts is deliberate:
 *
 *     full_refund  >  escalate  >  partial_refund  >  none
 *
 * `full_refund` wins because a rule that concludes the buyer received nothing
 * of value is not making a judgement call — the goods failed to arrive, and
 * holding that money pending review would be the wrong default.
 *
 * `escalate` beats `partial_refund` for the opposite reason: computing a
 * precise partial amount while some *other* part of the evidence is
 * contradictory would give a confident-looking number derived from data we
 * have already said we do not trust.
 */
import type { MandateTerms } from '../mandate/types.js';
import type { StructuredQuote } from '../drift/types.js';
import { structuredQuoteSchema } from '../drift/types.js';
import { sum } from '../money.js';
import {
  capRefund,
  SETTLEMENT_RULES,
  SETTLEMENT_RULES_VERSION,
  type SettlementContext,
} from './rules.js';
import {
  deliveryEvidenceSchema,
  type SettlementReason,
  type SettlementResult,
  type SettlementVerdict,
} from './types.js';

const PRECEDENCE: Record<SettlementVerdict, number> = {
  none: 0,
  partial_refund: 1,
  escalate: 2,
  full_refund: 3,
};

export interface EvaluateSettlementArgs {
  readonly mandate: MandateTerms;
  /** The quote that was actually authorized and captured. */
  readonly quote: unknown;
  readonly evidence: unknown;
  readonly now: Date;
  readonly capturedAmountPaise: bigint;
  readonly alreadyRefundedPaise: bigint;
}

export function evaluateSettlement(args: EvaluateSettlementArgs): SettlementResult {
  const evaluatedAt = args.now.toISOString();

  const base = {
    rulesVersion: SETTLEMENT_RULES_VERSION,
    evaluatedAt,
    autoExecutable: false,
  } as const;

  /**
   * Nothing was captured, so there is nothing to refund.
   *
   * An uncaptured hold is released in full, never refunded — the payment
   * lifecycle enforces that separately, and recommending a refund here would
   * produce something the gateway could not execute.
   */
  if (args.capturedAmountPaise <= 0n) {
    return {
      ...base,
      recommendation: 'none',
      refundAmountPaise: 0n,
      reasons: [
        {
          ruleId: 'NOT_CAPTURED',
          verdict: 'none',
          message:
            'No money has been captured for this intent. An uncaptured authorization is released in full, not refunded.',
        },
      ],
    };
  }

  const quote = structuredQuoteSchema.safeParse(args.quote);
  const evidence = deliveryEvidenceSchema.safeParse(args.evidence);

  // Unreadable evidence is escalated, never silently treated as "fine". The
  // failure mode we refuse is concluding `none` from data we could not parse.
  if (!quote.success || !evidence.success) {
    const issues = [
      ...(quote.success ? [] : quote.error.issues.map((i) => `quote.${i.path.join('.')}: ${i.message}`)),
      ...(evidence.success
        ? []
        : evidence.error.issues.map((i) => `evidence.${i.path.join('.')}: ${i.message}`)),
    ];
    return {
      ...base,
      recommendation: 'escalate',
      refundAmountPaise: 0n,
      reasons: [
        {
          ruleId: 'EVIDENCE_MALFORMED',
          verdict: 'escalate',
          message: `Could not read the settlement inputs: ${issues.join('; ')}`,
        },
      ],
    };
  }

  const ctx: SettlementContext = {
    now: args.now,
    capturedAmountPaise: args.capturedAmountPaise,
    alreadyRefundedPaise: args.alreadyRefundedPaise,
  };

  const reasons: SettlementReason[] = [];
  for (const rule of SETTLEMENT_RULES) {
    try {
      reasons.push(
        ...rule.evaluate({
          mandate: args.mandate,
          quote: quote.data as StructuredQuote,
          evidence: evidence.data,
          ctx,
        }),
      );
    } catch (err) {
      // A rule that throws must not silently vanish into a `none`.
      reasons.push({
        ruleId: 'EVIDENCE_MALFORMED',
        verdict: 'escalate',
        message: `Settlement rule "${rule.id}" failed to evaluate: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const recommendation = reasons.reduce<SettlementVerdict>(
    (worst, r) => (PRECEDENCE[r.verdict] > PRECEDENCE[worst] ? r.verdict : worst),
    'none',
  );

  const refundAmountPaise = computeRefund(recommendation, reasons, ctx);

  return {
    ...base,
    recommendation,
    refundAmountPaise,
    reasons,
    // Only a clean, uncontested refund may skip the human, and only when the
    // mandate said so at signing time.
    autoExecutable:
      args.mandate.autoRefundAllowed &&
      recommendation !== 'escalate' &&
      recommendation !== 'none' &&
      refundAmountPaise > 0n,
  };
}

function computeRefund(
  recommendation: SettlementVerdict,
  reasons: readonly SettlementReason[],
  ctx: SettlementContext,
): bigint {
  if (recommendation === 'full_refund') {
    return capRefund(ctx.capturedAmountPaise, ctx);
  }

  if (recommendation === 'partial_refund') {
    /**
     * Claims are grouped by SKU and the LARGEST is taken, not the sum.
     *
     * Several rules can describe the same physical units from different angles:
     * a damaged unit is also a unit that did not arrive in good condition, so
     * ITEM_DAMAGED and SHORT_QUANTITY both name it. Summing would refund it
     * twice. The largest claim for a SKU already covers every unit of it that
     * failed to arrive usable.
     */
    const bySku = new Map<string, bigint>();
    const unattributed: bigint[] = [];

    for (const reason of reasons) {
      if (reason.verdict !== 'partial_refund' || !reason.refundAmountPaise) continue;
      const amount = BigInt(reason.refundAmountPaise);

      if (!reason.sku) {
        unattributed.push(amount);
        continue;
      }
      const current = bySku.get(reason.sku) ?? 0n;
      if (amount > current) bySku.set(reason.sku, amount);
    }

    return capRefund(sum([...bySku.values(), ...unattributed]), ctx);
  }

  // escalate and none carry no amount: a human decides, or nothing is owed.
  return 0n;
}

/** One-line summary for logs and the console. */
export function summariseSettlement(result: SettlementResult): string {
  if (result.reasons.length === 0) return 'Delivery matches the mandate; nothing to settle.';
  return result.reasons.map((r) => `${r.ruleId} (${r.verdict}): ${r.message}`).join('; ');
}
