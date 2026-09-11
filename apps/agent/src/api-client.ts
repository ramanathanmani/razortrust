/**
 * The HTTP client Steward uses against a deployed RazorTrust API.
 *
 * It holds ONE secret: the agent's bearer token. It never sees a principal
 * token, a card, or a gateway key. Every money decision is made server-side;
 * this client is deliberately thin and turns non-2xx answers into structured
 * results instead of throwing, so the agent loop can report WHY it stopped.
 */
import { randomUUID } from 'node:crypto';

import type { ApiResult, RazorTrustClient } from './types.js';

export interface HttpApiConfig {
  baseUrl: string;
  agentToken: string;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class HttpRazorTrustClient implements RazorTrustClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: HttpApiConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.token = config.agentToken;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  private async request<T = any>(
    method: string,
    path: string,
    body?: unknown,
    idempotent = false,
  ): Promise<ApiResult<T>> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: 'application/json',
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    // Money-moving calls carry a fresh key; replaying a crashed cycle must
    // never double-move money.
    if (idempotent) headers['idempotency-key'] = randomUUID();

    let response: Response;
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    } catch (err) {
      return {
        status: 0,
        ok: false,
        body: { error: 'API_UNREACHABLE', message: err instanceof Error ? err.message : String(err) } as any,
      };
    }

    const text = await response.text();
    let parsed: any = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
    }
    return { status: response.status, ok: response.ok, body: parsed };
  }

  async createIntent(args: { mandateId: string; merchantId: string }) {
    return this.request('POST', '/v1/intents', args, true);
  }

  async structureFromText(intentId: string, rawInput: string) {
    return this.request('POST', `/v1/intents/${intentId}/quote/from-text`, { rawInput }, true);
  }

  async checkQuote(intentId: string) {
    return this.request('POST', `/v1/intents/${intentId}/check`);
  }

  async authorize(intentId: string) {
    return this.request('POST', `/v1/intents/${intentId}/authorize`, {}, true);
  }

  async capture(intentId: string) {
    return this.request('POST', `/v1/intents/${intentId}/capture`, {}, true);
  }

  async getIntent(intentId: string) {
    return this.request('GET', `/v1/intents/${intentId}`);
  }

  async recordDelivery(intentId: string, evidence: unknown, source: 'merchant_api' | 'ai_structured') {
    return this.request('POST', `/v1/intents/${intentId}/delivery`, { evidence, source }, true);
  }

  async settle(intentId: string) {
    return this.request('POST', `/v1/intents/${intentId}/settle`, {}, true);
  }

  async executeRefund(settlementId: string, amountPaise: string) {
    return this.request(
      'POST',
      `/v1/settlements/${settlementId}/execute`,
      { confirmRefundAmountPaise: amountPaise },
      true,
    );
  }
}
