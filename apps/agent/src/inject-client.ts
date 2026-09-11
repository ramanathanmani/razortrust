/**
 * In-process client driving a real Fastify server via `inject`.
 *
 * Used by the narrated demo and the e2e suite: the exact same routes,
 * middleware, auth, database and fake gateway a deployment runs, without a
 * TCP port. The agent itself is none the wiser — it sees the same JSON.
 */
import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

type UpperMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

import type { ApiResult, RazorTrustClient } from './types.js';

export interface RawResult {
  status: number;
  ok: boolean;
  body: any;
}

export type RawRequestFn = (args: {
  method: string;
  path: string;
  payload?: unknown;
  token: string;
  idempotencyKey?: string;
}) => Promise<RawResult>;

/** A token-explicit request function over in-process injection. */
export function injectRequester(app: FastifyInstance): RawRequestFn {
  return async ({ method, path, payload, token, idempotencyKey }) => {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (payload !== undefined) headers['content-type'] = 'application/json';
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;

    const res = await app.inject({
      method: method.toUpperCase() as UpperMethod,
      url: path,
      headers,
      payload: payload as any,
    });
    const body = res.body ? JSON.parse(res.body) : null;
    return { status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, body };
  };
}

/** Token-explicit HTTP request function, for the human-side setup CLI. */
export function httpRequester(baseUrl: string): RawRequestFn {
  const base = baseUrl.replace(/\/$/, '');
  return async ({ method, path, payload, token, idempotencyKey }) => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
    };
    if (payload !== undefined) headers['content-type'] = 'application/json';
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;

    const init: RequestInit = { method, headers };
    if (payload !== undefined) init.body = JSON.stringify(payload);
    const res = await fetch(`${base}${path}`, init);
    const text = await res.text();
    return { status: res.status, ok: res.ok, body: text ? JSON.parse(text) : null };
  };
}

/** Agent-facing RazorTrust client over in-process injection. */
export class InjectRazorTrustClient implements RazorTrustClient {
  private readonly request: RawRequestFn;

  constructor(
    app: FastifyInstance,
    private readonly token: string,
  ) {
    this.request = injectRequester(app);
  }

  /** Also available to the human (setup/demo) steps with an explicit token. */
  as(token: string): RawRequestFn {
    return (args) => this.request({ ...args, token });
  }

  private async call(method: string, path: string, payload?: unknown, idempotent = false): Promise<ApiResult> {
    const result = await this.request({
      method,
      path,
      payload,
      token: this.token,
      ...(idempotent ? { idempotencyKey: randomUUID() } : {}),
    });
    return result;
  }

  async createIntent(args: { mandateId: string; merchantId: string }) {
    return this.call('POST', '/v1/intents', args, true);
  }
  async structureFromText(intentId: string, rawInput: string) {
    return this.call('POST', `/v1/intents/${intentId}/quote/from-text`, { rawInput }, true);
  }
  async checkQuote(intentId: string) {
    return this.call('POST', `/v1/intents/${intentId}/check`);
  }
  async authorize(intentId: string) {
    return this.call('POST', `/v1/intents/${intentId}/authorize`, {}, true);
  }
  async capture(intentId: string) {
    return this.call('POST', `/v1/intents/${intentId}/capture`, {}, true);
  }
  async getIntent(intentId: string) {
    return this.call('GET', `/v1/intents/${intentId}`);
  }
  async recordDelivery(intentId: string, evidence: unknown, source: 'merchant_api' | 'ai_structured') {
    return this.call('POST', `/v1/intents/${intentId}/delivery`, { evidence, source }, true);
  }
  async settle(intentId: string) {
    return this.call('POST', `/v1/intents/${intentId}/settle`, {}, true);
  }
  async executeRefund(settlementId: string, amountPaise: string) {
    return this.call(
      'POST',
      `/v1/settlements/${settlementId}/execute`,
      { confirmRefundAmountPaise: amountPaise },
      true,
    );
  }
}
