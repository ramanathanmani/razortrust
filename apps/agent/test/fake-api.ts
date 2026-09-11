/**
 * In-memory test double for the RazorTrust API.
 *
 * It deliberately reuses the REAL deterministic quote parser from
 * @razortrust/adapters, but scripts the money-policy verdicts per quote ref —
 * the policy engine itself is covered by the API test suite and the STEWARD_E2E
 * suite. What these tests own is the AGENT's behaviour: tool ordering,
 * notifications, journal transitions, and the human/agent authority boundary.
 */
import { parseQuoteEmail } from '@razortrust/adapters';

import type { ApiResult, RazorTrustClient } from '../src/types.js';

export interface FakeOptions {
  /** quote refs the fake policy refuses, with rule summaries. */
  blocks?: Record<string, string[]>;
  /** quote refs already authorized by a human (sweep will capture them). */
  authorized?: string[];
  /** Settlement recommendation for delivery tests. */
  settlement?: {
    recommendation: string;
    refundAmountPaise: string;
    autoExecutable: boolean;
    summary?: string;
  };
  /** When false (default), the agent's refund attempt is refused with 403. */
  agentMayRefund?: boolean;
}

interface Intent {
  id: string;
  merchantId: string;
  quoteRef?: string;
  totalPaise?: string;
  state: string;
}

export class FakeRazorTrustClient implements RazorTrustClient {
  readonly calls: { method: string; args: unknown[] }[] = [];
  private readonly intents = new Map<string, Intent>();
  private counter = 0;
  refundAttemptsByAgent = 0;
  executed: { settlementId: string; amountPaise: string }[] = [];

  /** Seed an intent the journal already knows about (sweep and delivery tests). */
  seedIntent(id: string, quoteRef: string, totalPaise: string, state = 'authorized'): void {
    this.intents.set(id, { id, merchantId: 'brewline_test', quoteRef, totalPaise, state });
  }

  constructor(private readonly options: FakeOptions = {}) {}

  private record<T>(method: string, args: unknown[], result: ApiResult<T>): ApiResult<T> {
    this.calls.push({ method, args });
    return result;
  }

  private ok<T>(method: string, args: unknown[], body: T): ApiResult<T> {
    return this.record(method, args, { status: 200, ok: true, body });
  }

  private fail(
    method: string,
    args: unknown[],
    status: number,
    body: Record<string, unknown>,
  ): ApiResult {
    return this.record(method, args, { status, ok: false, body });
  }

  async createIntent(args: { mandateId: string; merchantId: string }): Promise<ApiResult> {
    const id = `intent_${++this.counter}`;
    this.intents.set(id, { id, merchantId: args.merchantId, state: 'created' });
    return this.ok('createIntent', [args], { intentId: id, state: 'created' });
  }

  async structureFromText(intentId: string, rawInput: string): Promise<ApiResult> {
    const intent = this.intents.get(intentId)!;
    const parsed = parseQuoteEmail(rawInput);
    if (!parsed.ok) {
      return this.fail('structureFromText', [intentId, rawInput], 422, {
        error: 'UNREADABLE_QUOTE',
        message: `could not ground a quote: ${parsed.reason}`,
      });
    }
    intent.quoteRef = parsed.extraction.merchantQuoteRef;
    intent.totalPaise = parsed.extraction.totalPaise;
    return this.ok('structureFromText', [intentId], {
      source: 'ai_structured',
      model: 'deterministic-parser',
      totalPaise: parsed.extraction.totalPaise,
      structuredQuote: { merchantQuoteRef: parsed.extraction.merchantQuoteRef },
    });
  }

  async checkQuote(intentId: string): Promise<ApiResult> {
    const intent = this.intents.get(intentId)!;
    const violations = (this.options.blocks ?? {})[intent.quoteRef ?? ''];
    if (violations?.length) {
      return this.fail('checkQuote', [intentId], 422, {
        error: 'MANDATE_REJECTED',
        message: 'Quote violates the signed mandate',
        detail: { violations: violations.map((ruleId) => ({ ruleId, message: ruleId })) },
      });
    }
    intent.state = 'quote_allowed';
    return this.ok('checkQuote', [intentId], {
      decision: 'allow',
      quoteHash: `qh_${intent.quoteRef}`,
      rulesVersion: '2026-08-28.1',
    });
  }

  async authorize(intentId: string): Promise<ApiResult> {
    const intent = this.intents.get(intentId)!;
    intent.state = 'awaiting_approval';
    return this.ok('authorize', [intentId], {
      state: 'awaiting_approval',
      amountPaise: intent.totalPaise ?? '0',
      currency: 'INR',
      approvalUrl: `/approve/token_${intent.id}`,
      approvalExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    });
  }

  async getIntent(intentId: string): Promise<ApiResult> {
    const intent = this.intents.get(intentId)!;
    const state = this.options.authorized?.includes(intent.quoteRef ?? '')
      ? 'authorized'
      : intent.state;
    return this.ok('getIntent', [intentId], {
      state,
      authorizedAmountPaise: intent.totalPaise ?? null,
    });
  }

  async capture(intentId: string): Promise<ApiResult> {
    const intent = this.intents.get(intentId)!;
    if (!this.options.authorized?.includes(intent.quoteRef ?? '')) {
      return this.fail('capture', [intentId], 409, {
        error: 'NOT_AUTHORIZED',
        message: 'The human has not completed checkout',
      });
    }
    intent.state = 'captured';
    return this.ok('capture', [intentId], {
      state: 'captured',
      capturedAmountPaise: intent.totalPaise ?? '0',
    });
  }

  async recordDelivery(intentId: string, evidence: unknown): Promise<ApiResult> {
    return this.ok('recordDelivery', [intentId, evidence], {
      deliveryId: `delivery_${++this.counter}`,
      status: (evidence as { status?: string })?.status ?? 'delivered',
    });
  }

  async settle(intentId: string): Promise<ApiResult> {
    const s = this.options.settlement ?? {
      recommendation: 'none',
      refundAmountPaise: '0',
      autoExecutable: false,
      summary: 'Delivery matched the order.',
    };
    return this.ok('settle', [intentId], {
      settlementId: `stl_${intentId}`,
      ...s,
    });
  }

  async executeRefund(settlementId: string, amountPaise: string): Promise<ApiResult> {
    this.refundAttemptsByAgent += 1;
    if (!this.options.agentMayRefund) {
      return this.fail('executeRefund', [settlementId, amountPaise], 403, {
        error: 'HUMAN_APPROVAL_REQUIRED',
        message: 'This mandate requires a human to approve refunds; an agent may not execute this settlement',
      });
    }
    this.executed.push({ settlementId, amountPaise });
    return this.ok('executeRefund', [settlementId, amountPaise], {
      refundId: `rf_${this.counter}`,
      kind: 'partial',
      amountPaise,
      state: 'partially_refunded',
    });
  }
}
