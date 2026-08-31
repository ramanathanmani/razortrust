/**
 * Capture deadlines.
 *
 * Razorpay auto-refunds an authorized-but-uncaptured payment after 3 days, so
 * 3 days is a hard ceiling, not a tunable. A mandate may ask for less; it can
 * never ask for more.
 *
 * The deadline is checked SYNCHRONOUSLY on the capture path. A background
 * sweeper is cleanup, not safety: if the sweeper is dead, lagging, or was never
 * deployed, capture must still refuse on its own. This module is what makes
 * that possible — it is pure, takes `now` as an argument, and has no idea a
 * sweeper exists.
 */

/** Razorpay's own ceiling. Nothing in RazorTrust may exceed it. */
export const MAX_CAPTURE_DEADLINE_HOURS = 72 as const;

/** Default hold when a mandate does not specify one. */
export const DEFAULT_CAPTURE_DEADLINE_HOURS = 72 as const;

/**
 * Refuse to capture this close to the deadline.
 *
 * A capture call that starts at T-5s can still land at the gateway after the
 * deadline, at which point we would be capturing a payment Razorpay considers
 * abandoned. Stopping early turns an ambiguous race into a clean refusal.
 */
export const CAPTURE_SAFETY_MARGIN_MS = 60_000 as const;

const HOUR_MS = 3_600_000;

export class CaptureDeadlineError extends Error {
  override readonly name = 'CaptureDeadlineError';
}

/** Clamp a requested hold to the gateway ceiling. Never throws upward. */
export function resolveDeadlineHours(requestedHours?: number): number {
  if (requestedHours === undefined) return DEFAULT_CAPTURE_DEADLINE_HOURS;
  if (!Number.isSafeInteger(requestedHours) || requestedHours <= 0) {
    throw new CaptureDeadlineError(
      `Capture deadline must be a positive whole number of hours, got ${requestedHours}`,
    );
  }
  return Math.min(requestedHours, MAX_CAPTURE_DEADLINE_HOURS);
}

/** The instant after which the authorization must be treated as gone. */
export function computeCaptureDeadline(authorizedAt: Date, requestedHours?: number): Date {
  const hours = resolveDeadlineHours(requestedHours);
  return new Date(authorizedAt.getTime() + hours * HOUR_MS);
}

export type CaptureWindowCheck =
  | { readonly ok: true; readonly msRemaining: number }
  | {
      readonly ok: false;
      readonly code: 'DEADLINE_PASSED' | 'WITHIN_SAFETY_MARGIN';
      readonly message: string;
      readonly deadline: string;
      readonly msRemaining: number;
    };

/**
 * The synchronous gate every capture attempt goes through.
 *
 * Call this immediately before hitting the gateway, inside the same
 * transaction that flips the intent to `capturing`.
 */
export function checkCaptureWindow(args: {
  readonly captureDeadline: Date;
  readonly now: Date;
  readonly safetyMarginMs?: number;
}): CaptureWindowCheck {
  const margin = args.safetyMarginMs ?? CAPTURE_SAFETY_MARGIN_MS;
  const msRemaining = args.captureDeadline.getTime() - args.now.getTime();

  if (msRemaining <= 0) {
    return {
      ok: false,
      code: 'DEADLINE_PASSED',
      message:
        'Capture deadline has passed; the authorization is expired or already auto-refunded by Razorpay',
      deadline: args.captureDeadline.toISOString(),
      msRemaining,
    };
  }

  if (msRemaining <= margin) {
    return {
      ok: false,
      code: 'WITHIN_SAFETY_MARGIN',
      message: `Too close to the capture deadline (${Math.round(msRemaining / 1000)}s left); refusing rather than racing the gateway`,
      deadline: args.captureDeadline.toISOString(),
      msRemaining,
    };
  }

  return { ok: true, msRemaining };
}
