/**
 * Reconciliation: what to do when a call's outcome is unknown.
 *
 * A capture that times out may or may not have moved money. The only honest
 * source of truth is the gateway itself, so we ask it and believe the answer.
 * We never guess, and we never retry a capture without asking first.
 *
 * This is why an intent can sit in `capturing`: that state means "we do not
 * know yet", and it is strictly better than picking a wrong answer.
 */
import type { PaymentGateway } from '@razortrust/adapters';
import { fromGatewayAmount } from '@razortrust/adapters';
import { prisma } from '@razortrust/db';

import { audit } from './audit.js';
import type { Config } from './config.js';

export type ReconcileOutcome =
  | { resolved: true; state: 'captured' | 'authorized' | 'released' | 'failed'; detail: string }
  | { resolved: false; detail: string };

/**
 * Ask the gateway what actually happened to one payment, and make our records
 * match. Safe to call repeatedly.
 */
export async function reconcileIntent(args: {
  config: Config;
  gateway: PaymentGateway;
  intentId: string;
}): Promise<ReconcileOutcome> {
  const intent = await prisma.paymentIntent.findUnique({
    where: { id: args.intentId },
    include: { authorization: true },
  });

  if (!intent?.authorization?.rzpPaymentId) {
    return { resolved: false, detail: 'No gateway payment to reconcile against' };
  }

  let payment;
  try {
    payment = await args.gateway.fetchPayment(intent.authorization.rzpPaymentId);
  } catch (err) {
    // Still unknown. Leave the intent where it is — `capturing` is an honest
    // state, and a sweeper or a later call will try again.
    return {
      resolved: false,
      detail: `Gateway unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const now = new Date();
  const amount = fromGatewayAmount(payment.amount);
  const refunded = fromGatewayAmount(payment.amount_refunded);

  switch (payment.status) {
    case 'captured': {
      // The money did move. Our timeout was a lie about the outcome.
      await prisma.$transaction([
        prisma.paymentIntent.update({
          where: { id: intent.id },
          data: { state: 'captured', capturedAmountPaise: amount },
        }),
        prisma.authorization.update({
          where: { intentId: intent.id },
          data: { capturedAt: now },
        }),
      ]);

      await audit(args.config, {
        tenantId: intent.tenantId,
        actorType: 'system',
        actorId: 'reconciler',
        eventType: 'capture.succeeded',
        intentId: intent.id,
        mandateId: intent.mandateId,
        payload: {
          reconciled: true,
          note: 'Capture outcome was ambiguous; the gateway confirms the payment was captured',
          amountPaise: amount.toString(),
          rzpPaymentId: payment.id,
        },
        occurredAt: now.toISOString(),
      });

      return { resolved: true, state: 'captured', detail: 'Gateway confirms captured' };
    }

    case 'authorized': {
      // The capture did not land. The hold is intact, so this is retryable —
      // subject to the deadline, which the capture route checks on its own.
      await prisma.paymentIntent.update({
        where: { id: intent.id },
        data: { state: 'authorized' },
      });
      return { resolved: true, state: 'authorized', detail: 'Hold intact; capture did not land' };
    }

    case 'refunded': {
      // Either we released it, or Razorpay auto-refunded an expired hold.
      const wasCaptured = intent.state === 'captured' || intent.capturedAmountPaise !== null;
      await prisma.$transaction([
        prisma.paymentIntent.update({
          where: { id: intent.id },
          data: { state: wasCaptured ? 'refunded' : 'released', refundedAmountPaise: refunded },
        }),
        prisma.authorization.update({
          where: { intentId: intent.id },
          data: {
            releasedAt: now,
            releaseReason: intent.authorization.releaseReason ?? 'gateway_auto_refund',
            releaseMethod: intent.authorization.releaseMethod ?? 'gateway_expiry',
          },
        }),
      ]);

      await audit(args.config, {
        tenantId: intent.tenantId,
        actorType: 'gateway',
        actorId: 'razorpay',
        eventType: wasCaptured ? 'refund.succeeded' : 'authorization.auto_refunded_by_gateway',
        intentId: intent.id,
        mandateId: intent.mandateId,
        payload: { reconciled: true, refundedPaise: refunded.toString() },
        occurredAt: now.toISOString(),
      });

      return { resolved: true, state: 'released', detail: 'Gateway reports the payment reversed' };
    }

    case 'failed': {
      await prisma.paymentIntent.update({ where: { id: intent.id }, data: { state: 'failed' } });
      await prisma.authorization.update({
        where: { intentId: intent.id },
        data: {
          failureCode: payment.error_code ?? 'UNKNOWN',
          failureMessage: payment.error_description ?? null,
        },
      });
      return { resolved: true, state: 'failed', detail: 'Gateway reports the payment failed' };
    }

    default:
      return { resolved: false, detail: `Gateway reports status "${payment.status}"` };
  }
}

/**
 * Find every intent stuck mid-capture and resolve it.
 *
 * Cleanup, not safety. Capture refuses on its own if the deadline has passed,
 * so a sweeper that never runs costs tidiness rather than money.
 */
export async function reconcileStuckIntents(args: {
  config: Config;
  gateway: PaymentGateway;
  olderThanMs?: number;
}): Promise<{ examined: number; resolved: number }> {
  const cutoff = new Date(Date.now() - (args.olderThanMs ?? 60_000));

  const stuck = await prisma.paymentIntent.findMany({
    where: { state: 'capturing', updatedAt: { lt: cutoff } },
    select: { id: true },
    take: 100,
  });

  let resolved = 0;
  for (const intent of stuck) {
    const outcome = await reconcileIntent({ ...args, intentId: intent.id });
    if (outcome.resolved) resolved += 1;
  }

  return { examined: stuck.length, resolved };
}
