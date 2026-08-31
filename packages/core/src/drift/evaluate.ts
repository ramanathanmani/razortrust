/**
 * The gate.
 *
 * Everything the agent asked for, everything the merchant offered, and
 * everything the human approved meet here — and plain code decides.
 *
 * Two properties this function has to keep:
 *   1. Fail closed. Any error, any malformed input, any unexpected shape
 *      produces `block`. There is no path through here that returns `allow`
 *      by falling off the end.
 *   2. Report everything. Rules are not short-circuited on first failure,
 *      because a human reading the audit log needs the whole picture, not the
 *      first thing that happened to be checked.
 */
import { sha256Canonical } from '../crypto.js';
import type { MandateTerms } from '../mandate/types.js';
import { RULES_VERSION, rulesForStage, type RuleContext } from './rules.js';
import {
  structuredQuoteSchema,
  type DriftResult,
  type DriftStage,
  type DriftViolation,
  type StructuredQuote,
} from './types.js';

export const QUOTE_HASH_DOMAIN = 'razortrust.quote.v1' as const;

/** Hash a validated quote. Ties a verdict to exact bytes. */
export function hashQuote(quote: StructuredQuote): string {
  return sha256Canonical({ domain: QUOTE_HASH_DOMAIN, quote });
}

export interface EvaluateDriftArgs {
  readonly mandate: MandateTerms;
  /** Raw or already-parsed. Validated here either way. */
  readonly quote: unknown;
  readonly stage: DriftStage;
  readonly now: Date;
  readonly cumulativeAuthorizedPaise: bigint;
  readonly authorizedAmountPaise?: bigint;
  readonly authorizedQuoteHash?: string;
}

export function evaluateDrift(args: EvaluateDriftArgs): DriftResult {
  const evaluatedAt = args.now.toISOString();

  // A quote that does not parse is not a quote. Block, and say where.
  const parsed = structuredQuoteSchema.safeParse(args.quote);
  if (!parsed.success) {
    return {
      decision: 'block',
      violations: parsed.error.issues.map((issue) => ({
        ruleId: 'QUOTE_MALFORMED' as const,
        message: issue.message,
        path: issue.path.join('.') || '(root)',
      })),
      rulesVersion: RULES_VERSION,
      stage: args.stage,
      quoteHash: '',
      evaluatedAt,
    };
  }

  const quote = parsed.data;
  const quoteHash = hashQuote(quote);

  const ctx: RuleContext = {
    stage: args.stage,
    now: args.now,
    cumulativeAuthorizedPaise: args.cumulativeAuthorizedPaise,
    ...(args.authorizedAmountPaise !== undefined
      ? { authorizedAmountPaise: args.authorizedAmountPaise }
      : {}),
    ...(args.authorizedQuoteHash ? { authorizedQuoteHash: args.authorizedQuoteHash } : {}),
    currentQuoteHash: quoteHash,
  };

  const violations: DriftViolation[] = [];

  for (const rule of rulesForStage(args.stage)) {
    try {
      violations.push(...rule.evaluate(args.mandate, quote, ctx));
    } catch (err) {
      // A rule that throws is a bug in the rule. It must not become an
      // accidental `allow`, so the failure itself becomes a violation.
      violations.push({
        ruleId: rule.id,
        message: `Rule ${rule.id} failed to evaluate: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return {
    decision: violations.length === 0 ? 'allow' : 'block',
    violations,
    rulesVersion: RULES_VERSION,
    stage: args.stage,
    quoteHash,
    evaluatedAt,
  };
}

/** Convenience for logs and API responses. */
export function summariseViolations(result: DriftResult): string {
  if (result.decision === 'allow') return 'No drift detected.';
  return result.violations.map((v) => `${v.ruleId}: ${v.message}`).join('; ');
}
