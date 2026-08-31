/**
 * An in-memory gateway.
 *
 * Not a stub — it implements the same interface and the same state rules, so
 * the routes, the state machine and the webhook path are exercised for real
 * without a network. It also does something a live test account cannot: it
 * produces timeouts, ambiguous 5xx failures and out-of-order webhooks on
 * demand, which are precisely the cases most likely to be wrong in production.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import { GatewayError } from './errors.js';
import { parseWebhookBody } from './client.js';
import {
  toGatewayAmount,
  type CaptureArgs,
  type CreateOrderArgs,
  type CreateOrderResult,
  type GatewayOrder,
  type GatewayPayment,
  type GatewayRefund,
  type NormalisedWebhookEvent,
  type PaymentGateway,
  type ReleaseResult,
  type RefundArgs,
} from './types.js';

/** Ways to make the gateway misbehave, one call at a time. */
export interface FaultInjection {
  /**
   * The nasty one: the capture SUCCEEDS at the gateway but the caller sees a
   * timeout. Reconciliation must discover the money moved.
   */
  readonly captureSucceedsButTimesOut?: boolean;
  /** A clean 5xx — ambiguous, nothing actually happened. */
  readonly captureAmbiguousFailure?: boolean;
  readonly captureTerminalFailure?: string;
  /** Refuse reversal, forcing the gateway_expiry path. */
  readonly releaseUnsupported?: boolean;
  readonly refundFails?: boolean;
}

export class FakeGateway implements PaymentGateway {
  readonly name = 'fake' as const;

  private readonly orders = new Map<string, GatewayOrder>();
  private readonly payments = new Map<string, GatewayPayment>();
  private readonly refunds = new Map<string, GatewayRefund>();
  private readonly byOrder = new Map<string, string>();

  /** Consumed by the next matching call, then cleared. */
  private faults: FaultInjection = {};

  constructor(private readonly webhookSecret = 'fake_webhook_secret') {}

  // ---- test controls ----------------------------------------------------

  injectFault(fault: FaultInjection): void {
    this.faults = fault;
  }

  clearFaults(): void {
    this.faults = {};
  }

  private takeFault<K extends keyof FaultInjection>(key: K): FaultInjection[K] {
    const value = this.faults[key];
    if (value) this.faults = { ...this.faults, [key]: undefined };
    return value;
  }

  /**
   * Simulate the human completing the hosted checkout.
   *
   * This is the step RazorTrust deliberately cannot perform: a person authorises
   * the payment on the gateway's page. The agent has no way to call it.
   */
  simulateCustomerAuthorization(orderId: string, method = 'card'): GatewayPayment {
    const order = this.orders.get(orderId);
    if (!order) throw new GatewayError('terminal', 'INVALID_ORDER_ID', `No such order ${orderId}`);

    const payment: GatewayPayment = {
      id: `pay_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
      order_id: orderId,
      amount: order.amount,
      amount_refunded: 0,
      currency: order.currency,
      status: 'authorized',
      method,
      captured: false,
      created_at: Math.floor(Date.now() / 1000),
    };

    this.payments.set(payment.id, payment);
    this.byOrder.set(orderId, payment.id);
    this.orders.set(orderId, { ...order, status: 'attempted' });
    return payment;
  }

  /** Razorpay's own 3-day auto-refund of a hold nobody captured. */
  simulateGatewayAutoRefund(paymentId: string): GatewayPayment {
    const payment = this.mustGetPayment(paymentId);
    if (payment.status !== 'authorized') return payment;
    const updated: GatewayPayment = {
      ...payment,
      status: 'refunded',
      amount_refunded: payment.amount,
    };
    this.payments.set(paymentId, updated);
    return updated;
  }

  /** Build a signed webhook body, as the gateway would send it. */
  buildWebhook(
    event: string,
    entity: { payment?: GatewayPayment; refund?: GatewayRefund },
  ): { body: string; signature: string; eventId: string } {
    const body = JSON.stringify({
      entity: 'event',
      event,
      payload: {
        ...(entity.payment ? { payment: { entity: entity.payment } } : {}),
        ...(entity.refund ? { refund: { entity: entity.refund } } : {}),
      },
    });
    return {
      body,
      signature: createHmac('sha256', this.webhookSecret).update(body, 'utf8').digest('hex'),
      eventId: randomUUID(),
    };
  }

  // ---- PaymentGateway ---------------------------------------------------

  async createOrder(args: CreateOrderArgs): Promise<CreateOrderResult> {
    const order: GatewayOrder = {
      id: `order_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
      amount: toGatewayAmount(args.amountPaise),
      currency: args.currency,
      status: 'created',
      receipt: args.receipt,
    };
    this.orders.set(order.id, order);
    return {
      order,
      checkoutUrl: `https://fake-checkout.local/pay?order_id=${order.id}`,
    };
  }

  async fetchPayment(paymentId: string): Promise<GatewayPayment> {
    return this.mustGetPayment(paymentId);
  }

  async capturePayment(args: CaptureArgs): Promise<GatewayPayment> {
    const payment = this.mustGetPayment(args.paymentId);

    if (this.takeFault('captureTerminalFailure')) {
      throw new GatewayError('terminal', 'BAD_REQUEST_ERROR', 'Injected terminal failure', 400);
    }

    if (this.takeFault('captureAmbiguousFailure')) {
      // Nothing changes on the gateway; the caller cannot know that.
      throw new GatewayError('ambiguous', 'SERVER_ERROR', 'Injected 5xx', 500);
    }

    if (payment.status === 'captured') {
      // Idempotent at the gateway, but the caller should not be relying on it.
      throw new GatewayError(
        'terminal',
        'PAYMENT_ALREADY_CAPTURED',
        'This payment has already been captured',
        400,
      );
    }
    if (payment.status !== 'authorized') {
      throw new GatewayError(
        'terminal',
        'BAD_REQUEST_ERROR',
        `Cannot capture a payment in status "${payment.status}"`,
        400,
      );
    }
    if (toGatewayAmount(args.amountPaise) !== payment.amount) {
      throw new GatewayError(
        'terminal',
        'BAD_REQUEST_ERROR',
        `Capture amount ${args.amountPaise} does not match the authorized ${payment.amount}`,
        400,
      );
    }

    const captured: GatewayPayment = { ...payment, status: 'captured', captured: true };
    this.payments.set(payment.id, captured);

    if (this.takeFault('captureSucceedsButTimesOut')) {
      // The state above is already committed. The caller sees only the error.
      throw new GatewayError('ambiguous', 'NETWORK_ERROR', 'socket hang up', undefined, {
        code: 'ECONNRESET',
      });
    }

    return captured;
  }

  async releaseAuthorization(args: CaptureArgs): Promise<ReleaseResult> {
    const payment = this.mustGetPayment(args.paymentId);

    if (this.takeFault('releaseUnsupported')) {
      return { released: false, method: 'gateway_expiry', refund: null };
    }

    if (payment.status !== 'authorized') {
      return { released: false, method: 'gateway_expiry', refund: null };
    }

    const refund = await this.createRefund({
      paymentId: args.paymentId,
      amountPaise: args.amountPaise,
      currency: args.currency,
      isPartial: false,
    });
    this.payments.set(payment.id, {
      ...payment,
      status: 'refunded',
      amount_refunded: payment.amount,
    });
    return { released: true, method: 'reversal', refund };
  }

  async createRefund(args: RefundArgs): Promise<GatewayRefund> {
    if (this.takeFault('refundFails')) {
      throw new GatewayError('terminal', 'BAD_REQUEST_ERROR', 'Injected refund failure', 400);
    }

    const payment = this.mustGetPayment(args.paymentId);
    const amount = toGatewayAmount(args.amountPaise);
    const remaining = payment.amount - payment.amount_refunded;

    if (amount > remaining) {
      throw new GatewayError(
        'terminal',
        'BAD_REQUEST_ERROR',
        `Refund ${amount} exceeds the ${remaining} still refundable`,
        400,
      );
    }

    const refund: GatewayRefund = {
      id: `rfnd_${randomUUID().replace(/-/g, '').slice(0, 14)}`,
      payment_id: args.paymentId,
      amount,
      currency: args.currency,
      status: 'processed',
      speed_processed: 'normal',
    };
    this.refunds.set(refund.id, refund);

    const refunded = payment.amount_refunded + amount;
    this.payments.set(payment.id, {
      ...payment,
      amount_refunded: refunded,
      status: refunded >= payment.amount && payment.status === 'captured' ? 'refunded' : payment.status,
    });

    return refund;
  }

  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    if (!signature) return false;
    const expected = createHmac('sha256', this.webhookSecret).update(rawBody, 'utf8').digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signature, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  parseWebhook(rawBody: string): NormalisedWebhookEvent {
    return parseWebhookBody(rawBody);
  }

  private mustGetPayment(paymentId: string): GatewayPayment {
    const payment = this.payments.get(paymentId);
    if (!payment) {
      throw new GatewayError('terminal', 'INVALID_PAYMENT_ID', `No such payment ${paymentId}`, 400);
    }
    return payment;
  }
}
