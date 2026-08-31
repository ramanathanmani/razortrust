import { describe, expect, it } from 'vitest';

import {
  CaptureDeadlineError,
  checkCaptureWindow,
  computeCaptureDeadline,
  MAX_CAPTURE_DEADLINE_HOURS,
  resolveDeadlineHours,
} from '../src/payment/deadline.js';
import {
  assertTransition,
  canTransition,
  checkReversal,
  PaymentStateError,
  reversalKindFor,
  supportsPartialReversal,
} from '../src/payment/lifecycle.js';

describe('capture deadline', () => {
  it('clamps any request to the Razorpay 3-day ceiling', () => {
    expect(resolveDeadlineHours(24)).toBe(24);
    expect(resolveDeadlineHours(168)).toBe(MAX_CAPTURE_DEADLINE_HOURS);
    expect(resolveDeadlineHours()).toBe(MAX_CAPTURE_DEADLINE_HOURS);
  });

  it('rejects nonsense hold durations', () => {
    expect(() => resolveDeadlineHours(0)).toThrow(CaptureDeadlineError);
    expect(() => resolveDeadlineHours(-4)).toThrow(CaptureDeadlineError);
    expect(() => resolveDeadlineHours(1.5)).toThrow(CaptureDeadlineError);
  });

  it('computes the deadline from the authorization instant', () => {
    const authorizedAt = new Date('2026-08-28T12:00:00.000Z');
    expect(computeCaptureDeadline(authorizedAt, 72).toISOString()).toBe(
      '2026-08-31T12:00:00.000Z',
    );
    // A mandate asking for a week still only gets three days.
    expect(computeCaptureDeadline(authorizedAt, 168).toISOString()).toBe(
      '2026-08-31T12:00:00.000Z',
    );
  });

  it('allows a capture comfortably inside the window', () => {
    const result = checkCaptureWindow({
      captureDeadline: new Date('2026-08-31T12:00:00.000Z'),
      now: new Date('2026-08-29T12:00:00.000Z'),
    });
    expect(result.ok).toBe(true);
  });

  it('refuses a capture after the deadline, sweeper or no sweeper', () => {
    const result = checkCaptureWindow({
      captureDeadline: new Date('2026-08-31T12:00:00.000Z'),
      now: new Date('2026-08-31T12:00:01.000Z'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('DEADLINE_PASSED');
  });

  it('refuses rather than racing the gateway inside the safety margin', () => {
    const result = checkCaptureWindow({
      captureDeadline: new Date('2026-08-31T12:00:00.000Z'),
      now: new Date('2026-08-31T11:59:30.000Z'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('WITHIN_SAFETY_MARGIN');
  });
});

describe('payment lifecycle', () => {
  it('allows the happy path', () => {
    expect(canTransition('created', 'quoted')).toBe(true);
    expect(canTransition('quoted', 'awaiting_authorization')).toBe(true);
    expect(canTransition('awaiting_authorization', 'authorized')).toBe(true);
    expect(canTransition('authorized', 'capturing')).toBe(true);
    expect(canTransition('capturing', 'captured')).toBe(true);
  });

  it('never lets a blocked intent reach money', () => {
    expect(canTransition('blocked', 'awaiting_authorization')).toBe(false);
    expect(canTransition('blocked', 'authorized')).toBe(false);
    expect(() => assertTransition('blocked', 'captured')).toThrow(PaymentStateError);
  });

  it('does not allow capture without an authorization', () => {
    expect(canTransition('created', 'captured')).toBe(false);
    expect(canTransition('quoted', 'captured')).toBe(false);
  });

  it('treats released and refunded as terminal', () => {
    expect(canTransition('released', 'captured')).toBe(false);
    expect(canTransition('refunded', 'partially_refunded')).toBe(false);
  });
});

describe('reversal rules', () => {
  it('classifies an authorized hold as a release, not a refund', () => {
    expect(reversalKindFor('authorized')).toBe('release');
    expect(supportsPartialReversal('authorized')).toBe(false);
  });

  it('classifies a captured payment as refundable', () => {
    expect(reversalKindFor('captured')).toBe('refund');
    expect(supportsPartialReversal('captured')).toBe(true);
  });

  it('refuses a partial reversal of an uncaptured hold', () => {
    const result = checkReversal({
      state: 'authorized',
      baseAmountPaise: 249_900n,
      alreadyRefundedPaise: 0n,
      requestedAmountPaise: 100_000n,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PARTIAL_RELEASE_UNSUPPORTED');
  });

  it('releases an uncaptured hold in full', () => {
    const result = checkReversal({
      state: 'authorized',
      baseAmountPaise: 249_900n,
      alreadyRefundedPaise: 0n,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.kind).toBe('release');
      expect(result.amountPaise).toBe(249_900n);
    }
  });

  it('allows a partial refund only after capture', () => {
    const result = checkReversal({
      state: 'captured',
      baseAmountPaise: 249_900n,
      alreadyRefundedPaise: 0n,
      requestedAmountPaise: 50_000n,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.kind).toBe('refund');
  });

  it('will not refund more than remains', () => {
    const result = checkReversal({
      state: 'partially_refunded',
      baseAmountPaise: 249_900n,
      alreadyRefundedPaise: 200_000n,
      requestedAmountPaise: 60_000n,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('REFUND_EXCEEDS_CAPTURED');
  });

  it('has nothing to reverse on a blocked intent', () => {
    const result = checkReversal({
      state: 'blocked',
      baseAmountPaise: 0n,
      alreadyRefundedPaise: 0n,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOTHING_TO_REVERSE');
  });
});
