/**
 * The gateway contract.
 *
 * Both the live Razorpay client and the in-memory fake implement this, so the
 * route handlers, the state machine and the tests are identical either way.
 * Nothing here decides anything — the adapter moves money when told to, and
 * @razortrust/core is what does the telling.
 */
import { z } from 'zod';

/**
 * Razorpay amounts are integers in the smallest currency unit — paise, which
 * is what we already use. The only conversion is bigint -> number, and it is
 * guarded rather than assumed.
 */
export function toGatewayAmount(paise: bigint): number {
  if (paise < 0n) throw new RangeError(`Amount must not be negative: ${paise}`);
  if (paise > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`Amount ${paise} exceeds the safe integer range for the gateway API`);
  }
  return Number(paise);
}

export function fromGatewayAmount(amount: number): bigint {
  if (!Number.isSafeInteger(amount)) {
    throw new RangeError(`Gateway returned a non-integer amount: ${amount}`);
  }
  return BigInt(amount);
}

// --------------------------------------------------------------------------
// Response schemas — every field we read is validated, never trusted.
// --------------------------------------------------------------------------

export const gatewayOrderSchema = z.object({
  id: z.string().min(1),
  amount: z.number().int().nonnegative(),
  currency: z.string().min(1),
  status: z.enum(['created', 'attempted', 'paid']),
  receipt: z.string().nullable().optional(),
});
export type GatewayOrder = z.infer<typeof gatewayOrderSchema>;

/**
 * `authorized` is a hold. `captured` is money that has moved. The distinction
 * drives every reversal decision downstream.
 */
export const gatewayPaymentSchema = z.object({
  id: z.string().min(1),
  order_id: z.string().min(1),
  amount: z.number().int().nonnegative(),
  amount_refunded: z.number().int().nonnegative().default(0),
  currency: z.string().min(1),
  status: z.enum(['created', 'authorized', 'captured', 'refunded', 'failed']),
  method: z.string().nullable().optional(),
  captured: z.boolean().optional(),
  error_code: z.string().nullable().optional(),
  error_description: z.string().nullable().optional(),
  created_at: z.number().int().optional(),
});
export type GatewayPayment = z.infer<typeof gatewayPaymentSchema>;

export const gatewayRefundSchema = z.object({
  id: z.string().min(1),
  payment_id: z.string().min(1),
  amount: z.number().int().nonnegative(),
  currency: z.string().min(1),
  status: z.enum(['pending', 'processed', 'failed']),
  speed_processed: z.string().nullable().optional(),
});
export type GatewayRefund = z.infer<typeof gatewayRefundSchema>;

// --------------------------------------------------------------------------
// Webhook events
// --------------------------------------------------------------------------

export const WEBHOOK_EVENT_TYPES = [
  'payment.authorized',
  'payment.captured',
  'payment.failed',
  'order.paid',
  'refund.created',
  'refund.processed',
  'refund.failed',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export interface NormalisedWebhookEvent {
  readonly eventType: WebhookEventType | 'unknown';
  /** Razorpay's `x-razorpay-event-id`, when present. */
  readonly providerEventId: string | null;
  readonly paymentId: string | null;
  readonly orderId: string | null;
  readonly refundId: string | null;
  readonly payment: GatewayPayment | null;
  readonly refund: GatewayRefund | null;
  readonly rawBody: string;
}

// --------------------------------------------------------------------------
// The interface
// --------------------------------------------------------------------------

export interface CreateOrderArgs {
  readonly amountPaise: bigint;
  readonly currency: string;
  /** Our intent id, so a gateway record can be traced back without our DB. */
  readonly receipt: string;
  readonly notes?: Record<string, string>;
}

export interface CreateOrderResult {
  readonly order: GatewayOrder;
  /**
   * Where the human completes the payment.
   *
   * RazorTrust never holds an instrument, so the hold is created by a person
   * on the gateway's own hosted page. The agent receives this URL and nothing
   * more — it cannot complete the payment itself.
   */
  readonly checkoutUrl: string;
}

export interface CaptureArgs {
  readonly paymentId: string;
  readonly amountPaise: bigint;
  readonly currency: string;
}

export interface ReleaseResult {
  readonly released: boolean;
  /**
   * How the hold was given up.
   *
   * `reversal` — we actively reversed it.
   * `gateway_expiry` — the gateway offers no reversal for this payment, so the
   *   hold will lapse into Razorpay's own auto-refund within 3 days. Recorded
   *   honestly rather than reported as a completed release.
   */
  readonly method: 'reversal' | 'gateway_expiry';
  readonly refund: GatewayRefund | null;
}

export interface RefundArgs {
  readonly paymentId: string;
  readonly amountPaise: bigint;
  readonly currency: string;
  readonly isPartial: boolean;
  readonly notes?: Record<string, string>;
}

export interface PaymentGateway {
  readonly name: 'razorpay' | 'fake';

  /** Always created with manual capture. There is no auto-capture path. */
  createOrder(args: CreateOrderArgs): Promise<CreateOrderResult>;

  /** The source of truth when a call's outcome is ambiguous. */
  fetchPayment(paymentId: string): Promise<GatewayPayment>;

  capturePayment(args: CaptureArgs): Promise<GatewayPayment>;

  /**
   * Give up an uncaptured hold.
   *
   * Razorpay has no dedicated void endpoint, so this attempts a full reversal
   * of the authorized payment and falls back to letting the 3-day expiry do
   * it. Kept inside the adapter so no route handler has to know that.
   */
  releaseAuthorization(args: CaptureArgs): Promise<ReleaseResult>;

  createRefund(args: RefundArgs): Promise<GatewayRefund>;

  verifyWebhookSignature(rawBody: string, signature: string): boolean;

  parseWebhook(rawBody: string): NormalisedWebhookEvent;
}
