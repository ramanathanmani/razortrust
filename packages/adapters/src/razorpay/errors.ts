/**
 * Gateway error classification.
 *
 * This is the most important file in the adapter, and the reason is narrow:
 * a capture that times out has an UNKNOWN outcome. The money may have moved.
 * Treating that as a failure and retrying risks a double capture; treating it
 * as a success risks reporting a payment that never happened.
 *
 * So there are three kinds, not two:
 *
 *   retryable  — provably nothing happened. Safe to call again.
 *   terminal   — provably rejected. Never call again.
 *   ambiguous  — we do not know. NEVER retry blindly; reconcile by fetching
 *                the payment from the gateway and believing what it says.
 *
 * Anything unrecognised is ambiguous. That is deliberate: an unknown error is
 * exactly the case where guessing is most likely to be wrong.
 */

export type GatewayErrorKind = 'retryable' | 'terminal' | 'ambiguous';

export class GatewayError extends Error {
  override readonly name = 'GatewayError';

  constructor(
    readonly kind: GatewayErrorKind,
    readonly code: string,
    message: string,
    readonly httpStatus?: number,
    readonly raw?: unknown,
  ) {
    super(message);
  }

  /** True when the caller must reconcile before doing anything else. */
  get requiresReconciliation(): boolean {
    return this.kind === 'ambiguous';
  }
}

/**
 * Razorpay error codes we can classify with confidence.
 * Everything absent from this map falls through to `ambiguous`.
 */
const TERMINAL_CODES = new Set([
  'BAD_REQUEST_ERROR',
  'GATEWAY_ERROR',
  'ORDER_ALREADY_PAID',
  'PAYMENT_ALREADY_CAPTURED',
  'PAYMENT_ALREADY_REFUNDED',
  'INVALID_PAYMENT_ID',
  'INVALID_ORDER_ID',
  'AUTHENTICATION_ERROR',
]);

const RETRYABLE_CODES = new Set(['RATE_LIMIT_ERROR', 'SERVER_ERROR_RETRYABLE']);

/**
 * Network-level failures.
 *
 * A connection that was never established is retryable — the request did not
 * reach the gateway. A connection that was established and then died is
 * ambiguous, because the gateway may have processed it before the socket went.
 */
const RETRYABLE_SYSCALL_ERRORS = new Set(['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN']);
const AMBIGUOUS_SYSCALL_ERRORS = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ABORT_ERR']);

export function classifyHttpStatus(status: number, code?: string): GatewayErrorKind {
  if (code && TERMINAL_CODES.has(code)) return 'terminal';
  if (code && RETRYABLE_CODES.has(code)) return 'retryable';

  // 4xx means the gateway understood and refused: nothing happened.
  if (status === 429) return 'retryable';
  if (status >= 400 && status < 500) return 'terminal';

  // 5xx after the request was accepted: the gateway may have acted before
  // failing. This is the case that must never be blindly retried.
  if (status >= 500) return 'ambiguous';

  return 'ambiguous';
}

export function classifyNetworkError(err: unknown): GatewayErrorKind {
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code: unknown }).code)
      : '';

  if (RETRYABLE_SYSCALL_ERRORS.has(code)) return 'retryable';
  if (AMBIGUOUS_SYSCALL_ERRORS.has(code)) return 'ambiguous';
  return 'ambiguous';
}

export function isGatewayError(err: unknown): err is GatewayError {
  return err instanceof GatewayError;
}
