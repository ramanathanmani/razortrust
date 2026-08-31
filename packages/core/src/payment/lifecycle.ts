/**
 * The payment lifecycle, and what reversal is legal at each point.
 *
 * The distinction that matters: an authorization is a hold, not money that has
 * moved. You cannot partially undo a hold — there is no "partial void". Only a
 * captured payment can be partially refunded. Encoding that here means the
 * settlement engine cannot recommend something the gateway would reject.
 */

export const PAYMENT_STATES = [
  'created', // intent exists, nothing at the gateway yet
  'quoted', // merchant quote captured and structured
  'blocked', // drift check said no; terminal
  'awaiting_authorization', // order created with capture: "manual"
  'authorized', // funds held, not moved
  'capturing', // capture in flight; guards the deadline race
  'captured', // money has moved
  'released', // hold given up before capture
  'refunded', // captured then fully refunded
  'partially_refunded', // captured then partially refunded
  'failed', // gateway-level failure; terminal
] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

const TERMINAL: ReadonlySet<PaymentState> = new Set<PaymentState>([
  'blocked',
  'released',
  'refunded',
  'failed',
]);

export const isTerminal = (state: PaymentState): boolean => TERMINAL.has(state);

/** Legal transitions. Anything not listed is rejected at the state machine. */
const TRANSITIONS: Readonly<Record<PaymentState, readonly PaymentState[]>> = {
  created: ['quoted', 'blocked', 'failed'],
  quoted: ['awaiting_authorization', 'blocked', 'failed'],
  blocked: [],
  awaiting_authorization: ['authorized', 'released', 'failed'],
  // `released` from `authorized` covers both an explicit reversal and the
  // gateway's own 3-day auto-refund of an uncaptured hold.
  authorized: ['capturing', 'released', 'failed'],
  capturing: ['captured', 'authorized', 'failed'],
  captured: ['refunded', 'partially_refunded'],
  released: [],
  refunded: [],
  partially_refunded: ['refunded', 'partially_refunded'],
  failed: [],
};

export function canTransition(from: PaymentState, to: PaymentState): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export class PaymentStateError extends Error {
  override readonly name = 'PaymentStateError';
}

export function assertTransition(from: PaymentState, to: PaymentState): void {
  if (!canTransition(from, to)) {
    throw new PaymentStateError(`Illegal payment transition: ${from} -> ${to}`);
  }
}

/**
 * How money can be given back from a given state.
 *
 * - `release`   — an uncaptured hold. All or nothing; there is no partial.
 * - `refund`    — a captured payment. Full or partial.
 * - `none`      — nothing to reverse.
 */
export type ReversalKind = 'release' | 'refund' | 'none';

export function reversalKindFor(state: PaymentState): ReversalKind {
  switch (state) {
    case 'awaiting_authorization':
    case 'authorized':
      return 'release';
    case 'captured':
    case 'partially_refunded':
      return 'refund';
    default:
      return 'none';
  }
}

export function supportsPartialReversal(state: PaymentState): boolean {
  return reversalKindFor(state) === 'refund';
}

export type ReversalCheck =
  | { readonly ok: true; readonly kind: Exclude<ReversalKind, 'none'>; readonly amountPaise: bigint }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Validate a proposed reversal against the state and the amounts.
 *
 * This is the guard that turns "partial refunds only after capture" from a
 * comment in a design doc into something the code cannot get wrong.
 */
export function checkReversal(args: {
  readonly state: PaymentState;
  /** Amount originally captured, or held if not yet captured. */
  readonly baseAmountPaise: bigint;
  /** Already refunded against this payment. */
  readonly alreadyRefundedPaise: bigint;
  /** Requested amount; omit for a full reversal. */
  readonly requestedAmountPaise?: bigint;
}): ReversalCheck {
  const kind = reversalKindFor(args.state);

  if (kind === 'none') {
    return {
      ok: false,
      code: 'NOTHING_TO_REVERSE',
      message: `Payment is in state "${args.state}"; there is nothing to release or refund`,
    };
  }

  const refundable = args.baseAmountPaise - args.alreadyRefundedPaise;

  if (kind === 'release') {
    if (
      args.requestedAmountPaise !== undefined &&
      args.requestedAmountPaise !== args.baseAmountPaise
    ) {
      return {
        ok: false,
        code: 'PARTIAL_RELEASE_UNSUPPORTED',
        message:
          'An authorized payment has not moved any money and can only be released in full. ' +
          'Partial amounts are only meaningful after capture.',
      };
    }
    return { ok: true, kind: 'release', amountPaise: args.baseAmountPaise };
  }

  const amount = args.requestedAmountPaise ?? refundable;

  if (amount <= 0n) {
    return { ok: false, code: 'INVALID_REFUND_AMOUNT', message: 'Refund amount must be positive' };
  }
  if (amount > refundable) {
    return {
      ok: false,
      code: 'REFUND_EXCEEDS_CAPTURED',
      message: `Refund of ${amount} exceeds the ${refundable} still refundable on this payment`,
    };
  }

  return { ok: true, kind: 'refund', amountPaise: amount };
}
