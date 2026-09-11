/**
 * A deterministic quote parser.
 *
 * The Strands agent (Steward) often runs with no model budget at all — in a
 * demo, in CI, on a laptop without credentials. Structuring a purchase quote
 * must not stop working just because an LLM endpoint is unreachable, and per
 * the product's central rule it may never become a *guess*. This parser is
 * the answer: plain regexes over common invoice/email conventions, producing
 * the same `ExtractedQuote` candidate an LLM would, with every cited excerpt
 * copied straight out of the input.
 *
 * The grounding check still runs — excerpts are substrings by construction,
 * because this file only ever quotes text it actually read — and the output
 * still faces `structuredQuoteSchema`. Anything it cannot fully parse is an
 * abstention, never a partial quote.
 */
import { extractedQuoteSchema, type ExtractedQuote } from './types.js';
import { toStructuredQuote } from './verify.js';
import type { QuoteStructurer, StructureQuoteArgs, StructuringResult } from './types.js';

interface ParsedLine {
  sku: string;
  description: string | null;
  quantity: number;
  unitPricePaise: string;
  /** The exact text the unit price was read from — verbatim from the input. */
  sourceExcerpt: string;
}

interface ParsedMoney {
  paise: string;
  /** Verbatim label + amount text, e.g. `TOTAL:    Rs 2,449.00`. */
  excerpt: string;
}

const CURRENCY_WORDS: Record<string, string> = {
  INR: 'INR',
  RS: 'INR',
  RUPEES: 'INR',
  '₹': 'INR',
};

/** `Rs 2,449.00` / `₹1750` / `INR 499.50` -> integer paise, or null. */
function parseAmount(token: string): string | null {
  const cleaned = token
    .replace(/[,\s]/g, '')
    .replace(/^(inr|rs|rupees|₹)/i, '');
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const rupees = match[1] ?? '';
  const frac = (match[2] ?? '').padEnd(2, '0');
  return `${rupees}${frac}`;
}

/** Find a labelled money line (Subtotal / Tax / Total ...) and quote it. */
function findLabelledAmount(
  rawInput: string,
  patterns: RegExp[],
): ParsedMoney | null {
  for (const pattern of patterns) {
    const match = pattern.exec(rawInput);
    if (!match) continue;
    const excerpt = match[0].trim();
    const amountToken = match[2] ?? match[1] ?? '';
    const paise = parseAmount(amountToken);
    if (paise === null) continue;
    return { paise, excerpt };
  }
  return null;
}

/**
 * Line convention Steward understands:
 *   `2 x USB-C Cable 2m [SKU-USBC-CABLE-2M] ..... Rs 500.00 each`
 * The SKU in square brackets is mandatory: a line we cannot tie to an
 * approved SKU is a line the drift engine could never allow.
 */
function parseLineItems(rawInput: string): { lines: ParsedLine[]; reason?: string } {
  const lines: ParsedLine[] = [];
  const lineRegex =
    /^\s*(\d+)\s*x\s+(.+?)\s+\[([A-Z0-9][A-Z0-9._-]{2,})\]\s*[\-.:=]*\s*(.+?)(?:\s+each)?\s*$/gim;

  for (const match of rawInput.matchAll(lineRegex)) {
    const quantity = Number(match[1]);
    const description = (match[2] ?? '').trim() || null;
    const sku = match[3] ?? '';
    const priceToken = (match[4] ?? '').trim();
    const paise = parseAmount(priceToken);
    if (!Number.isInteger(quantity) || quantity <= 0 || paise === null) {
      return { lines: [], reason: `Could not parse line: "${match[0]?.trim()}"` };
    }
    lines.push({
      sku,
      description,
      quantity,
      unitPricePaise: paise,
      // Quote the tail of the line exactly as the merchant wrote it.
      sourceExcerpt: priceToken.replace(/\s+each$/i, '').trim(),
    });
  }

  if (lines.length === 0) {
    return { lines: [], reason: 'No line items in "qty x description [SKU] price" form' };
  }
  return { lines };
}

/** Resolve an ISO-8601 date, or a plain YYYY-MM-DD date, to ms-precision UTC. */
function parseDeliveryDate(rawInput: string): { iso: string; excerpt: string } | null {
  const explicit =
    /(?:delivery(?:\s+expected)?(?:\s+by)?|arrives?|deliver(?:ed|y)?(?:\s+by)?)\s*:?\s*(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?)/i.exec(
      rawInput,
    );
  if (!explicit) return null;
  const dateText = explicit[1] ?? '';
  const iso = dateText.includes('T') ? dateText : `${dateText}T00:00:00.000Z`;
  if (Number.isNaN(Date.parse(iso))) return null;
  return { iso, excerpt: dateText };
}

function detectCurrency(rawInput: string): string | null {
  const upper = rawInput.toUpperCase();
  for (const [word, code] of Object.entries(CURRENCY_WORDS)) {
    if (word === '₹') {
      if (rawInput.includes('₹')) return code;
    } else if (new RegExp(`\\b${word}\\b`).test(upper)) {
      return code;
    }
  }
  return null;
}

/** Build a candidate extraction, or an abstention with a stated reason. */
export function parseQuoteEmail(rawInput: string):
  | { ok: true; extraction: ExtractedQuote }
  | { ok: false; reason: string } {
  const text = rawInput.trim();

  const currency = detectCurrency(text);
  if (!currency) {
    return { ok: false, reason: 'No recognised currency marker (INR / Rs / ₹)' };
  }

  const linesResult = parseLineItems(text);
  if (!linesResult.lines.length || linesResult.reason) {
    return { ok: false, reason: linesResult.reason ?? 'No parseable line items' };
  }

  const total = findLabelledAmount(text, [
    /\b(?:grand\s+)?total\b\s*:?\s*((?:inr|rs|rupees|₹)?\s*[\d,]+(?:\.\d{1,2})?)/gi,
  ]);
  if (!total) {
    return { ok: false, reason: 'No final total found; abstaining rather than computing one' };
  }

  const subtotal = findLabelledAmount(text, [
    /\bsub-?total\b\s*:?\s*((?:inr|rs|rupees|₹)?\s*[\d,]+(?:\.\d{1,2})?)/gi,
  ]);
  const tax = findLabelledAmount(text, [
    /\btax(?:\s+incl)?(?:\s*\d+%)?\b\s*:?\s*((?:inr|rs|rupees|₹)?\s*[\d,]+(?:\.\d{1,2})?)/gi,
  ]);
  const shipping = findLabelledAmount(text, [
    /\b(?:shipping|delivery\s+charge|freight)\b\s*:?\s*((?:inr|rs|rupees|₹)?\s*[\d,]+(?:\.\d{1,2})?)/gi,
  ]);
  const discount = findLabelledAmount(text, [
    /\b(?:discount|coupon|offer)\b\s*:?\s*((?:inr|rs|rupees|₹)?\s*[\d,]+(?:\.\d{1,2})?)/gi,
  ]);

  const delivery = parseDeliveryDate(text);
  if (!delivery) {
    return { ok: false, reason: 'No promised delivery date; abstaining' };
  }

  const quoteRefMatch = /\b(?:quote|order|invoice)\s*(?:ref(?:erence)?)?\s*:?\s*([A-Z0-9][A-Z0-9-]{3,})\b/i.exec(
    text,
  );
  const expires =
    /(?:quote\s+)?(?:valid|expires?)\s*(?:until|on|by)\s*:?\s*(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?)/i.exec(
      text,
    );

  const candidate = {
    abstained: false,
    abstainReason: null,
    currency,
    merchantQuoteRef: quoteRefMatch?.[1] ?? null,
    lineItems: linesResult.lines.map((line) => ({
      sku: line.sku,
      description: line.description,
      unitPricePaise: line.unitPricePaise,
      quantity: line.quantity,
      lineTotalPaise: (BigInt(line.unitPricePaise) * BigInt(line.quantity)).toString(),
      sourceExcerpt: line.sourceExcerpt,
    })),
    subtotalPaise: subtotal?.paise ?? linesResult.lines
      .reduce((sum, line) => sum + BigInt(line.unitPricePaise) * BigInt(line.quantity), 0n)
      .toString(),
    taxPaise: tax?.paise ?? '0',
    shippingPaise: shipping?.paise ?? '0',
    discountPaise: discount?.paise ?? '0',
    totalPaise: total.paise,
    totalSourceExcerpt: total.excerpt,
    promisedDeliveryAt: delivery.iso,
    quoteExpiresAt: expires?.[1]
      ? expires[1].includes('T')
        ? expires[1]
        : `${expires[1]}T00:00:00.000Z`
      : null,
    // A parser has no uncertainty. Recorded for audit; gates nothing.
    confidence: 100,
  };

  const parsed = extractedQuoteSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `Parser produced a malformed extraction: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    };
  }
  return { ok: true, extraction: parsed.data };
}

/**
 * Same `QuoteStructurer` interface as the Anthropic client, so the API picks
 * it with one config value and the route code cannot tell (or care) which one
 * produced a candidate.
 */
export class DeterministicQuoteStructurer implements QuoteStructurer {
  readonly name = 'deterministic-parser' as const;

  async structureQuote(args: StructureQuoteArgs): Promise<StructuringResult> {
    const model = this.name;
    const rawInput = args.rawInput.trim();

    if (!rawInput) {
      return {
        ok: false,
        model,
        rejection: { code: 'EMPTY_INPUT', message: 'No merchant input was supplied' },
      };
    }

    const parsed = parseQuoteEmail(rawInput);
    if (!parsed.ok) {
      return {
        ok: false,
        model,
        rejection: {
          code: 'MODEL_ABSTAINED',
          message: `The deterministic parser could not read a complete quote: ${parsed.reason}`,
        },
      };
    }

    // The real verification path: verbatim grounding, then the same schema a
    // merchant API faces. No shortcut.
    const verified = toStructuredQuote({
      extracted: parsed.extraction,
      rawInput,
      merchantId: args.merchantId,
      now: args.now,
    });

    if (!verified.ok) {
      return { ok: false, model, rejection: verified.rejection, rawModelOutput: parsed.extraction };
    }

    return {
      ok: true,
      quote: verified.quote,
      model,
      confidence: parsed.extraction.confidence,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
    };
  }
}
