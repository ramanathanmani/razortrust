/**
 * The Anthropic-backed quote structurer.
 *
 * Its whole job is turning messy text into a candidate that plain code then
 * accepts or rejects. It has no opinion about money, and it cannot express one:
 * the only thing it returns is a StructuredQuote that already passed
 * `structuredQuoteSchema`, or a rejection.
 */
import Anthropic from '@anthropic-ai/sdk';

import { buildUserPrompt, STRUCTURING_SYSTEM_PROMPT } from './prompt.js';
import { EXTRACTED_QUOTE_JSON_SCHEMA } from './schema.js';
import { extractedQuoteSchema } from './types.js';
import { toStructuredQuote } from './verify.js';
import type {
  QuoteStructurer,
  StructureQuoteArgs,
  StructuringResult,
} from './types.js';

export interface StructurerConfig {
  readonly apiKey?: string;
  /** Defaults to Claude Opus 5. */
  readonly model?: string;
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
}

export const DEFAULT_STRUCTURING_MODEL = 'claude-opus-5';

/** Beyond this, a "quote" is something else and the model should not see it. */
const MAX_INPUT_CHARS = 100_000;

export class AnthropicQuoteStructurer implements QuoteStructurer {
  readonly name = 'anthropic' as const;

  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(config: StructurerConfig = {}) {
    this.client = new Anthropic({
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      timeout: config.timeoutMs ?? 60_000,
    });
    this.model = config.model ?? DEFAULT_STRUCTURING_MODEL;
    this.maxTokens = config.maxTokens ?? 16_000;
  }

  async structureQuote(args: StructureQuoteArgs): Promise<StructuringResult> {
    const rawInput = args.rawInput.trim();

    if (!rawInput) {
      return {
        ok: false,
        model: this.model,
        rejection: { code: 'EMPTY_INPUT', message: 'No merchant input was supplied' },
      };
    }
    if (rawInput.length > MAX_INPUT_CHARS) {
      // Truncating would silently drop the part of the document containing the
      // real total, so refuse instead.
      return {
        ok: false,
        model: this.model,
        rejection: {
          code: 'NOT_VALID_QUOTE',
          message: `Input is ${rawInput.length} characters, over the ${MAX_INPUT_CHARS} limit. Supply the quote itself rather than a whole thread.`,
        },
      };
    }

    let response;
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        // Adaptive thinking: extraction is where careful reading pays off, and
        // the deterministic checks downstream catch anything it gets wrong.
        thinking: { type: 'adaptive' },
        // The system prompt is frozen and identical on every call, so it caches.
        // The merchant input goes in the user turn, after the breakpoint.
        system: [
          {
            type: 'text',
            text: STRUCTURING_SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: buildUserPrompt(rawInput) }],
        output_config: { format: { type: 'json_schema', schema: EXTRACTED_QUOTE_JSON_SCHEMA } },
      });
    } catch (err) {
      // A model that is unreachable produces no quote. It never produces a
      // guess, and it never lets the previous quote stand in.
      return {
        ok: false,
        model: this.model,
        rejection: {
          code: 'MODEL_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    // A safety decline is a refusal to answer, not an answer. Check the stop
    // reason before reading content — content is not an answer here.
    if (response.stop_reason === 'refusal') {
      const category = response.stop_details?.category;
      return {
        ok: false,
        model: this.model,
        rejection: {
          code: 'MODEL_REFUSED',
          message: `The model declined to process this input${category ? ` (${category})` : ''}`,
        },
      };
    }

    // Hitting the output cap means the JSON is truncated. Truncated JSON is not
    // a partial quote, it is not a quote.
    if (response.stop_reason === 'max_tokens') {
      return {
        ok: false,
        model: this.model,
        rejection: {
          code: 'MODEL_ERROR',
          message: 'The model hit its output limit; the extraction was truncated',
        },
      };
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    let candidate: unknown;
    try {
      candidate = JSON.parse(text);
    } catch {
      return {
        ok: false,
        model: this.model,
        rejection: {
          code: 'SCHEMA_MISMATCH',
          message: 'The model did not return parseable JSON',
        },
      };
    }

    // The API constrained the output to a JSON Schema; we re-validate against
    // our own Zod schema regardless. Two independent statements of the shape,
    // so a mistake in either one is caught rather than trusted.
    const parsedExtraction = extractedQuoteSchema.safeParse(candidate);
    if (!parsedExtraction.success) {
      return {
        ok: false,
        model: this.model,
        rawModelOutput: candidate,
        rejection: {
          code: 'SCHEMA_MISMATCH',
          message: 'Model output does not satisfy the extraction schema',
          detail: parsedExtraction.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        },
      };
    }
    const extracted = parsedExtraction.data;

    const verified = toStructuredQuote({
      extracted,
      rawInput,
      merchantId: args.merchantId,
      now: args.now,
    });

    if (!verified.ok) {
      return {
        ok: false,
        model: this.model,
        rejection: verified.rejection,
        rawModelOutput: extracted,
      };
    }

    return {
      ok: true,
      quote: verified.quote,
      model: this.model,
      confidence: extracted.confidence,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      },
    };
  }
}
