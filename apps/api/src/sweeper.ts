/**
 * The sweeper.
 *
 * Explicitly NOT a safety mechanism. Capture checks its own deadline
 * synchronously, so an intent past its window is refused whether or not this
 * ever runs. What the sweeper does is tidy up: mark lapsed holds as released,
 * and resolve intents left stuck mid-capture by an ambiguous failure.
 *
 * If it is dead, lagging, or was never deployed, nothing unsafe happens.
 */
import type { PaymentGateway } from '@razortrust/adapters';
import { prisma } from '@razortrust/db';

import { audit } from './audit.js';
import type { Config } from './config.js';
import { reconcileStuckIntents } from './reconcile.js';

export interface SweepResult {
  readonly lapsedHolds: number;
  readonly reconciled: number;
  readonly examined: number;
}

export async function runSweep(args: {
  config: Config;
  gateway: PaymentGateway;
  now?: Date;
}): Promise<SweepResult> {
  const now = args.now ?? new Date();

  // 1. Holds whose deadline has passed. Razorpay auto-refunds these; we record
  //    it so the intent does not sit in `authorized` forever looking live.
  const lapsed = await prisma.authorization.findMany({
    where: {
      captureDeadline: { lt: now },
      capturedAt: null,
      releasedAt: null,
      intent: { state: 'authorized' },
    },
    include: { intent: true },
    take: 100,
  });

  for (const auth of lapsed) {
    await prisma.$transaction([
      prisma.paymentIntent.update({
        where: { id: auth.intentId },
        data: { state: 'released' },
      }),
      prisma.authorization.update({
        where: { intentId: auth.intentId },
        data: {
          releasedAt: now,
          releaseReason: 'deadline_passed',
          releaseMethod: 'gateway_expiry',
        },
      }),
      // The hold is gone, so give the amount back to the mandate's ceiling.
      prisma.mandate.update({
        where: { id: auth.intent.mandateId },
        data: { cumulativeAuthorizedPaise: { decrement: auth.amountPaise } },
      }),
    ]);

    await audit(args.config, {
      tenantId: auth.intent.tenantId,
      actorType: 'system',
      actorId: 'sweeper',
      eventType: 'authorization.auto_refunded_by_gateway',
      intentId: auth.intentId,
      mandateId: auth.intent.mandateId,
      payload: {
        reason: 'deadline_passed',
        deadline: auth.captureDeadline?.toISOString() ?? null,
        amountPaise: auth.amountPaise.toString(),
        note: 'Hold passed its capture deadline; Razorpay auto-refunds uncaptured payments after 3 days.',
      },
      occurredAt: now.toISOString(),
    });
  }

  // 2. Intents stuck mid-capture, where the outcome was never determined.
  const { examined, resolved } = await reconcileStuckIntents({
    config: args.config,
    gateway: args.gateway,
  });

  return { lapsedHolds: lapsed.length, reconciled: resolved, examined };
}

/** Start the periodic sweep. Returns a stop function. */
export function startSweeper(args: {
  config: Config;
  gateway: PaymentGateway;
  intervalMs?: number;
  onError?: (err: unknown) => void;
}): () => void {
  const interval = setInterval(() => {
    void runSweep(args).catch((err) => args.onError?.(err));
  }, args.intervalMs ?? 60_000);

  interval.unref?.();
  return () => clearInterval(interval);
}
