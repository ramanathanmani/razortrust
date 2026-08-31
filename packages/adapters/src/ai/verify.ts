/**
 * Deterministic verification of model output.
 *
 * This is the file that makes "the AI only structures messy inputs" true
 * rather than aspirational. Nothing here asks the model anything; it is plain
 * string and schema work over what the model already returned.
 *
 * Three gates, in order:
 *   1. Did the model abstain? Then stop — abstention is a valid answer.
 *   2. Is every figure GROUNDED — does the excerpt it cited actually appear in
 *      the input? A hallucinated price cannot survive a substring check.
 *   3. Does the candidate satisfy `structuredQuoteSchema` exactly — the same
 *      schema a merchant API's response has to satisfy?
 *
 * Any failure rejects. There is no repair, no coercion, no "close enough".
 */
import { structuredQuoteSchema } from '@razortrust/core';

import type { ExtractedQuote, StructuringRejection } from './types.js';

/**
 * Normalise text for substring comparison.
 *
 * Whitespace and case are collapsed because an HTML invoice wraps lines
 * unpredictably and the model will not reproduce that byte for byte. Digits,
 * letters and punctuation are left alone — those are what actually carry the
 * figure, and loosening them would defeat the check.
 */
export function normaliseForGrounding(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Is every cited excerpt really in the source?
 *
 * A model that invents "₹1,750" for an item the email never priced will cite
 * an excerpt that is not in the email, and this catches it without anyone
 * having to trust the model's self-report.
 */
export function checkGrounding(
  extracted: ExtractedQuote,
  rawInput: string,
): { grounded: true } | { grounded: false; ungrounded: string[] } {
  const haystack = normaliseForGrounding(rawInput);
  const ungrounded: string[] = [];

  const check = (excerpt: string, label: string) => {
    const needle = normaliseForGrounding(excerpt);
    // An empty excerpt is not proof of anything.
    if (!needle) {
      ungrounded.push(`${label}: no source excerpt provided`);
      return;
    }
    if (!haystack.includes(needle)) {
      ungrounded.push(`${label}: cited text "${excerpt}" does not appear in the input`);
    }
  };

  for (const [i, line] of extracted.lineItems.entries()) {
    check(line.sourceExcerpt, `lineItems[${i}] (${line.sku})`);
  }
  check(extracted.totalSourceExcerpt, 'totalPaise');

  return ungrounded.length === 0 ? { grounded: true } : { grounded: false, ungrounded };
}

/**
 * Turn a verified candidate into a StructuredQuote, or reject it.
 *
 * `merchantId` and `capturedAt` are supplied by the caller, never taken from
 * the model: merchant identity decides whether the mandate permits the
 * purchase at all, and a timestamp the model chose would be a timestamp a
 * merchant could influence.
 */
export function toStructuredQuote(args: {
  extracted: ExtractedQuote;
  rawInput: string;
  merchantId: string;
  now: Date;
}): { ok: true; quote: unknown } | { ok: false; rejection: StructuringRejection } {
  const { extracted, rawInput, merchantId, now } = args;

  if (extracted.abstained) {
    return {
      ok: false,
      rejection: {
        code: 'MODEL_ABSTAINED',
        message:
          extracted.abstainReason ??
          'The model could not read a complete quote from this input and declined to guess',
      },
    };
  }

  const grounding = checkGrounding(extracted, rawInput);
  if (!grounding.grounded) {
    return {
      ok: false,
      rejection: {
        code: 'UNGROUNDED_FIGURE',
        message: 'One or more extracted figures are not present in the source text',
        detail: grounding.ungrounded,
      },
    };
  }

  const candidate = {
    quoteVersion: 1 as const,
    merchantId,
    currency: extracted.currency,
    lineItems: extracted.lineItems.map((l) => ({
      sku: l.sku,
      ...(l.description ? { description: l.description } : {}),
      unitPricePaise: l.unitPricePaise,
      quantity: l.quantity,
      lineTotalPaise: l.lineTotalPaise,
    })),
    subtotalPaise: extracted.subtotalPaise,
    taxPaise: extracted.taxPaise,
    shippingPaise: extracted.shippingPaise,
    discountPaise: extracted.discountPaise,
    totalPaise: extracted.totalPaise,
    promisedDeliveryAt: extracted.promisedDeliveryAt,
    ...(extracted.quoteExpiresAt ? { quoteExpiresAt: extracted.quoteExpiresAt } : {}),
    ...(extracted.merchantQuoteRef ? { merchantQuoteRef: extracted.merchantQuoteRef } : {}),
    capturedAt: now.toISOString(),
  };

  // The same schema, the same strictness, the same rejection as a merchant
  // API's response would face. This is the whole point.
  const parsed = structuredQuoteSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      rejection: {
        code: 'SCHEMA_MISMATCH',
        message: 'Model output does not satisfy the structured quote schema',
        detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      },
    };
  }

  return { ok: true, quote: candidate };
}
