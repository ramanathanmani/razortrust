/**
 * A deterministic stand-in for the model.
 *
 * It runs the real verification path — grounding checks, the real
 * `structuredQuoteSchema` — over a canned extraction, so the tests exercise
 * everything except the network call. That matters more than it sounds: the
 * interesting failures here are hallucinated figures and abstentions, and a
 * live model produces those only by luck.
 */
import { extractedQuoteSchema, type ExtractedQuote } from './types.js';
import { toStructuredQuote } from './verify.js';
import type { QuoteStructurer, StructureQuoteArgs, StructuringResult } from './types.js';

export class FakeQuoteStructurer implements QuoteStructurer {
  readonly name = 'fake' as const;

  private nextExtraction: ExtractedQuote | null = null;
  private nextFailure: 'refusal' | 'error' | null = null;

  /** Queue what the "model" will return next. */
  setNextExtraction(extraction: ExtractedQuote): void {
    this.nextExtraction = extractedQuoteSchema.parse(extraction);
  }

  /** Simulate a safety decline or an unreachable API. */
  setNextFailure(kind: 'refusal' | 'error'): void {
    this.nextFailure = kind;
  }

  async structureQuote(args: StructureQuoteArgs): Promise<StructuringResult> {
    const model = 'fake-structurer';
    const rawInput = args.rawInput.trim();

    if (!rawInput) {
      return {
        ok: false,
        model,
        rejection: { code: 'EMPTY_INPUT', message: 'No merchant input was supplied' },
      };
    }

    const failure = this.nextFailure;
    this.nextFailure = null;
    if (failure === 'refusal') {
      return {
        ok: false,
        model,
        rejection: { code: 'MODEL_REFUSED', message: 'The model declined to process this input' },
      };
    }
    if (failure === 'error') {
      return {
        ok: false,
        model,
        rejection: { code: 'MODEL_ERROR', message: 'Connection to the model failed' },
      };
    }

    const extracted = this.nextExtraction;
    this.nextExtraction = null;
    if (!extracted) {
      return {
        ok: false,
        model,
        rejection: {
          code: 'MODEL_ABSTAINED',
          message: 'No extraction was queued; the fake abstains by default',
        },
      };
    }

    // The real verification, not a shortcut.
    const verified = toStructuredQuote({
      extracted,
      rawInput,
      merchantId: args.merchantId,
      now: args.now,
    });

    if (!verified.ok) {
      return { ok: false, model, rejection: verified.rejection, rawModelOutput: extracted };
    }

    return {
      ok: true,
      quote: verified.quote,
      model,
      confidence: extracted.confidence,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
    };
  }
}
