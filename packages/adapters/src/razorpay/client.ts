/**
 * The live Razorpay gateway.
 *
 * Deliberately hand-rolled over fetch rather than the SDK: every response is
 * validated against a schema before it is believed, timeouts are explicit, and
 * the retry policy is visible in one place. A payment adapter that silently
 * retries is a payment adapter that double-charges.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  classifyHttpStatus,
  classifyNetworkError,
  GatewayError,
} from './errors.js';
import {
  gatewayOrderSchema,
  gatewayPaymentSchema,
  gatewayRefundSchema,
  toGatewayAmount,
  WEBHOOK_EVENT_TYPES,
  type CaptureArgs,
  type CreateOrderArgs,
  type CreateOrderResult,
  type GatewayPayment,
  type GatewayRefund,
  type NormalisedWebhookEvent,
  type PaymentGateway,
  type ReleaseResult,
  type RefundArgs,
  type WebhookEventType,
} from './types.js';

export interface RazorpayConfig {
  readonly keyId: string;
  readonly keySecret: string;
  readonly webhookSecret: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly checkoutBaseUrl?: string;
}

const DEFAULT_BASE_URL = 'https://api.razorpay.com/v1';
const DEFAULT_TIMEOUT_MS = 20_000;

export class RazorpayGateway implements PaymentGateway {
  readonly name = 'razorpay' as const;

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly authHeader: string;

  constructor(private readonly config: RazorpayConfig) {
    if (!config.keyId || !config.keySecret) {
      throw new Error('RazorpayGateway requires keyId and keySecret');
    }
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.authHeader = `Basic ${Buffer.from(`${config.keyId}:${config.keySecret}`).toString('base64')}`;
  }

  private async request<T>(args: {
    method: 'GET' | 'POST';
    path: string;
    body?: unknown;
    /** Only ever true for reads. Writes are never retried automatically. */
    retryable: boolean;
  }): Promise<T> {
    const attempts = args.retryable ? 3 : 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(`${this.baseUrl}${args.path}`, {
          method: args.method,
          headers: {
            Authorization: this.authHeader,
            'Content-Type': 'application/json',
          },
          ...(args.body ? { body: JSON.stringify(args.body) } : {}),
          signal: controller.signal,
        });

        const text = await response.text();

        if (!response.ok) {
          const parsed = safeJson(text);
          const code =
            (parsed as { error?: { code?: string } })?.error?.code ?? `HTTP_${response.status}`;
          const description =
            (parsed as { error?: { description?: string } })?.error?.description ?? text.slice(0, 500);

          const kind = classifyHttpStatus(response.status, code);

          // A retryable read may go round again; a write never does.
          if (kind === 'retryable' && attempt < attempts) {
            lastError = new GatewayError(kind, code, description, response.status, parsed);
            await sleep(backoffMs(attempt));
            continue;
          }

          throw new GatewayError(kind, code, description, response.status, parsed);
        }

        return safeJson(text) as T;
      } catch (err) {
        if (err instanceof GatewayError) throw err;

        const kind = classifyNetworkError(err);
        const error = new GatewayError(
          kind,
          'NETWORK_ERROR',
          err instanceof Error ? err.message : String(err),
          undefined,
          err,
        );

        if (kind === 'retryable' && attempt < attempts) {
          lastError = error;
          await sleep(backoffMs(attempt));
          continue;
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError instanceof GatewayError
      ? lastError
      : new GatewayError('ambiguous', 'UNKNOWN', 'Request failed after retries', undefined, lastError);
  }

  async createOrder(args: CreateOrderArgs): Promise<CreateOrderResult> {
    const raw = await this.request<unknown>({
      method: 'POST',
      path: '/orders',
      retryable: false,
      body: {
        amount: toGatewayAmount(args.amountPaise),
        currency: args.currency,
        receipt: args.receipt,
        // The whole product depends on this being manual. An order created
        // with auto-capture would take the money before any drift check runs.
        capture: 'manual',
        notes: args.notes ?? {},
      },
    });

    const order = gatewayOrderSchema.parse(raw);
    const checkoutBase = this.config.checkoutBaseUrl ?? 'https://checkout.razorpay.com/v1/checkout';
    return {
      order,
      checkoutUrl: `${checkoutBase}?order_id=${encodeURIComponent(order.id)}&key_id=${encodeURIComponent(this.config.keyId)}`,
    };
  }

  async fetchPayment(paymentId: string): Promise<GatewayPayment> {
    // Reads are safe to retry, and this is the call reconciliation depends on.
    const raw = await this.request<unknown>({
      method: 'GET',
      path: `/payments/${encodeURIComponent(paymentId)}`,
      retryable: true,
    });
    return gatewayPaymentSchema.parse(raw);
  }

  async capturePayment(args: CaptureArgs): Promise<GatewayPayment> {
    const raw = await this.request<unknown>({
      method: 'POST',
      path: `/payments/${encodeURIComponent(args.paymentId)}/capture`,
      retryable: false,
      body: { amount: toGatewayAmount(args.amountPaise), currency: args.currency },
    });
    return gatewayPaymentSchema.parse(raw);
  }

  /**
   * Give up an uncaptured hold.
   *
   * There is no void endpoint. A full refund against an authorized payment
   * reverses it where the method supports that; where it does not, the honest
   * answer is that the hold will lapse under Razorpay's 3-day auto-refund, and
   * that is what gets returned rather than a false success.
   */
  async releaseAuthorization(args: CaptureArgs): Promise<ReleaseResult> {
    try {
      const refund = await this.createRefund({
        paymentId: args.paymentId,
        amountPaise: args.amountPaise,
        currency: args.currency,
        isPartial: false,
        notes: { reason: 'razortrust_release_authorization' },
      });
      return { released: true, method: 'reversal', refund };
    } catch (err) {
      if (err instanceof GatewayError && err.kind === 'terminal') {
        // The gateway will not reverse it. Not an error — the hold expires on
        // its own, and the sweeper confirms that later.
        return { released: false, method: 'gateway_expiry', refund: null };
      }
      throw err;
    }
  }

  async createRefund(args: RefundArgs): Promise<GatewayRefund> {
    const raw = await this.request<unknown>({
      method: 'POST',
      path: `/payments/${encodeURIComponent(args.paymentId)}/refund`,
      retryable: false,
      body: {
        amount: toGatewayAmount(args.amountPaise),
        speed: 'normal',
        notes: args.notes ?? {},
      },
    });
    return gatewayRefundSchema.parse(raw);
  }

  /**
   * Verify a webhook signature over the EXACT bytes received.
   *
   * The raw body matters: re-serialising a parsed object changes whitespace and
   * key order, and the HMAC will not match. The route registers a raw-body
   * parser for this path so the original text survives.
   */
  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    if (!this.config.webhookSecret || !signature) return false;

    const expected = createHmac('sha256', this.config.webhookSecret)
      .update(rawBody, 'utf8')
      .digest('hex');

    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signature, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  parseWebhook(rawBody: string): NormalisedWebhookEvent {
    return parseWebhookBody(rawBody);
  }
}

/** Shared by the live gateway and the fake, so both normalise identically. */
export function parseWebhookBody(rawBody: string): NormalisedWebhookEvent {
  const body = safeJson(rawBody) as {
    event?: string;
    payload?: {
      payment?: { entity?: unknown };
      refund?: { entity?: unknown };
      order?: { entity?: { id?: string } };
    };
  };

  const eventName = body?.event ?? '';
  const eventType: WebhookEventType | 'unknown' = (
    WEBHOOK_EVENT_TYPES as readonly string[]
  ).includes(eventName)
    ? (eventName as WebhookEventType)
    : 'unknown';

  const paymentParsed = gatewayPaymentSchema.safeParse(body?.payload?.payment?.entity);
  const refundParsed = gatewayRefundSchema.safeParse(body?.payload?.refund?.entity);

  const payment = paymentParsed.success ? paymentParsed.data : null;
  const refund = refundParsed.success ? refundParsed.data : null;

  return {
    eventType,
    providerEventId: null, // supplied by the x-razorpay-event-id header
    paymentId: payment?.id ?? refund?.payment_id ?? null,
    orderId: payment?.order_id ?? body?.payload?.order?.entity?.id ?? null,
    refundId: refund?.id ?? null,
    payment,
    refund,
    rawBody,
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const backoffMs = (attempt: number) => 200 * 2 ** (attempt - 1);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
