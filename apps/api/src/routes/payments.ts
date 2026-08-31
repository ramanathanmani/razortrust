/**
 * The money-moving endpoints.
 *
 * Every one of them is a thin sequence: re-verify the mandate, re-run the
 * rules, check the deadline, flip the state, call the gateway, write it down.
 * Not one line of this file decides whether a payment is allowed — it asks
 * @razortrust/core and does as it is told.
 */
import { isGatewayError, type PaymentGateway } from '@razortrust/adapters';
import {
  assertTransition,
  checkCaptureWindow,
  checkReversal,
  computeCaptureDeadline,
  evaluateDrift,
  mandateTermsSchema,
  verifyMandate,
  type MandateTerms,
} from '@razortrust/core';
import { prisma, toCanonicalJson } from '@razortrust/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { authenticateAgent } from '../auth.js';
import { audit } from '../audit.js';
import type { Config } from '../config.js';
import { ApiError, badRequest, blockedByDrift, conflict, mandateRejected, notFound } from '../errors.js';
import { getGateway } from '../gateway.js';
import { withIdempotency } from '../idempotency.js';
import { issueApprovalToken } from './approve.js';
import { reconcileIntent } from '../reconcile.js';

const releaseSchema = z.object({ reason: z.string().max(200).optional() }).strict();

/** Load intent + mandate + latest quote, and re-verify all of it. */
async function loadForPayment(args: {
  intentId: string;
  tenantId: string;
  agentId: string;
  now: Date;
}) {
  const intent = await prisma.paymentIntent.findFirst({
    where: { id: args.intentId, tenantId: args.tenantId, agentId: args.agentId },
    include: { authorization: true, merchant: true },
  });
  if (!intent) throw notFound('Intent');

  const mandateRow = await prisma.mandate.findUnique({ where: { id: intent.mandateId } });
  if (!mandateRow) throw notFound('Mandate');

  const verification = verifyMandate({
    mandate: {
      terms: mandateTermsSchema.parse(JSON.parse(mandateRow.termsJson)),
      termsHash: mandateRow.termsHash,
      signature: mandateRow.signature ?? '',
      signedByPublicKeyPem: mandateRow.signedByPublicKeyPem ?? '',
      signedAt: mandateRow.signedAt?.toISOString() ?? '',
    },
    state: {
      status: mandateRow.status as 'active',
      usesCount: mandateRow.usesCount,
      cumulativeAuthorizedPaise: mandateRow.cumulativeAuthorizedPaise,
      ...(mandateRow.revokedAt ? { revokedAt: mandateRow.revokedAt.toISOString() } : {}),
    },
    presentedBy: { tenantId: args.tenantId, agentId: args.agentId },
    now: args.now,
  });

  const quote = await prisma.quote.findFirst({
    where: { intentId: intent.id },
    orderBy: { createdAt: 'desc' },
  });

  return { intent, mandateRow, verification, quote };
}

export async function paymentRoutes(app: FastifyInstance, config: Config) {
  const gateway: PaymentGateway = getGateway(config);

  /**
   * Create the hold.
   *
   * Returns a checkout URL, not a payment. RazorTrust holds no instrument, so
   * a person completes the payment on the gateway's own page and the webhook
   * tells us the hold exists. The agent cannot complete it.
   */
  app.post('/v1/intents/:id/authorize', async (request, reply) => {
    const identity = await authenticateAgent(request);
    const { id } = request.params as { id: string };
    const now = new Date();

    const idem = await withIdempotency({
      request,
      identity,
      endpoint: 'POST /v1/intents/:id/authorize',
      body: { intentId: id },
      required: true,
    });
    if (idem?.replayed) return reply.status(idem.status).send(idem.body);

    const { intent, mandateRow, verification, quote } = await loadForPayment({
      intentId: id,
      tenantId: identity.tenantId,
      agentId: identity.agentId,
      now,
    });

    if (!verification.ok) throw mandateRejected(verification.failures);
    if (!quote) throw badRequest('No quote attached to this intent');
    if (intent.state !== 'quoted') {
      throw conflict(`Cannot authorize an intent in state "${intent.state}"`);
    }

    // The rules run again here. Passing /check earlier is not a ticket.
    const drift = evaluateDrift({
      mandate: verification.terms,
      quote: JSON.parse(quote.structuredJson),
      stage: 'pre_authorization',
      now,
      cumulativeAuthorizedPaise: mandateRow.cumulativeAuthorizedPaise,
    });

    await prisma.driftCheck.create({
      data: {
        intentId: intent.id,
        quoteId: quote.id,
        decision: drift.decision,
        violationsJson: toCanonicalJson(drift.violations),
        rulesVersion: drift.rulesVersion,
        stage: 'pre_authorization',
      },
    });

    if (drift.decision === 'block') {
      await prisma.paymentIntent.update({
        where: { id: intent.id },
        data: { state: 'blocked', blockedReasonJson: toCanonicalJson(drift.violations) },
      });
      await audit(config, {
        tenantId: identity.tenantId,
        actorType: 'agent',
        actorId: identity.agentId,
        eventType: 'drift.blocked',
        intentId: intent.id,
        mandateId: mandateRow.id,
        payload: { stage: 'pre_authorization', violations: drift.violations.map((v) => v.ruleId) },
        occurredAt: now.toISOString(),
      });
      throw blockedByDrift(drift.violations);
    }

    await audit(config, {
      tenantId: identity.tenantId,
      actorType: 'agent',
      actorId: identity.agentId,
      eventType: 'authorization.requested',
      intentId: intent.id,
      mandateId: mandateRow.id,
      payload: { amountPaise: quote.totalPaise.toString(), quoteHash: quote.quoteHash },
      occurredAt: now.toISOString(),
    });

    let order;
    try {
      order = await gateway.createOrder({
        amountPaise: quote.totalPaise,
        currency: quote.currency,
        receipt: intent.id,
        notes: { mandateId: mandateRow.id, mandateHash: mandateRow.termsHash },
      });
    } catch (err) {
      await audit(config, {
        tenantId: identity.tenantId,
        actorType: 'system',
        actorId: 'gateway',
        eventType: 'authorization.failed',
        intentId: intent.id,
        mandateId: mandateRow.id,
        payload: { error: err instanceof Error ? err.message : String(err) },
        occurredAt: new Date().toISOString(),
      });
      throw new ApiError(502, 'GATEWAY_ERROR', 'Could not create the order at the gateway');
    }

    assertTransition('quoted', 'awaiting_authorization');

    // The mandate is consumed at authorization, not at capture: a hold reserves
    // the ceiling. Releasing gives the amount back (see /release below), but
    // never the use — otherwise an agent could churn holds indefinitely.
    await prisma.$transaction([
      prisma.authorization.create({
        data: {
          intentId: intent.id,
          rzpOrderId: order.order.id,
          captureMode: 'manual',
          amountPaise: quote.totalPaise,
          currency: quote.currency,
        },
      }),
      prisma.paymentIntent.update({
        where: { id: intent.id },
        data: { state: 'awaiting_authorization' },
      }),
      prisma.mandate.update({
        where: { id: mandateRow.id },
        data: {
          usesCount: { increment: 1 },
          cumulativeAuthorizedPaise: { increment: quote.totalPaise },
        },
      }),
    ]);

    /**
     * The link the human follows.
     *
     * Bound to this intent and to the mandate's owner, hashed at rest, single
     * use, and short-lived. The agent receives the URL and can do nothing with
     * it — every check runs again when a person actually opens it.
     */
    const approval = await issueApprovalToken({
      tenantId: identity.tenantId,
      intentId: intent.id,
      principalId: mandateRow.principalId,
      now,
    });

    const body = {
      intentId: intent.id,
      state: 'awaiting_authorization',
      orderId: order.order.id,
      amountPaise: quote.totalPaise.toString(),
      currency: quote.currency,
      captureMode: 'manual',
      /** A person completes this. The agent cannot. */
      approvalUrl: `/approve/${approval.token}`,
      approvalExpiresAt: approval.expiresAt.toISOString(),
      note: 'Send this link to the approving human. It works once, expires, and re-checks the mandate and the quote when opened.',
    };
    if (idem && !idem.replayed) await idem.complete(201, body, intent.id);
    return reply.status(201).send(body);
  });

  /**
   * Capture the hold.
   *
   * The order of the guards below is the whole safety argument, and it is
   * deliberate: verify, re-evaluate, check the clock, claim the row, only then
   * touch the gateway.
   */
  app.post('/v1/intents/:id/capture', async (request, reply) => {
    const identity = await authenticateAgent(request);
    const { id } = request.params as { id: string };
    const now = new Date();

    const idem = await withIdempotency({
      request,
      identity,
      endpoint: 'POST /v1/intents/:id/capture',
      body: { intentId: id },
      required: true,
    });
    if (idem?.replayed) return reply.status(idem.status).send(idem.body);

    const { intent, mandateRow, verification, quote } = await loadForPayment({
      intentId: id,
      tenantId: identity.tenantId,
      agentId: identity.agentId,
      now,
    });

    const auth = intent.authorization;
    if (!auth?.rzpPaymentId || !auth.authorizedAt || !auth.captureDeadline) {
      throw conflict('This intent has no completed authorization to capture');
    }
    if (intent.state !== 'authorized') {
      throw conflict(`Cannot capture an intent in state "${intent.state}"`);
    }

    // 1. The mandate may have been revoked since the hold was placed.
    if (!verification.ok) {
      await releaseHold({
        config,
        gateway,
        intentId: intent.id,
        tenantId: identity.tenantId,
        mandateId: mandateRow.id,
        paymentId: auth.rzpPaymentId,
        amountPaise: auth.amountPaise,
        currency: auth.currency,
        reason: 'drift_at_capture',
        actorId: 'system',
      });
      throw mandateRejected(verification.failures);
    }

    // 2. The rules run again, at the capture stage, against the quote that was
    //    actually authorized.
    if (!quote) throw badRequest('No quote attached to this intent');
    const drift = evaluateDrift({
      mandate: verification.terms as MandateTerms,
      quote: JSON.parse(quote.structuredJson),
      stage: 'pre_capture',
      now,
      // Exclude this intent's own hold, or it would count against itself.
      cumulativeAuthorizedPaise: mandateRow.cumulativeAuthorizedPaise - auth.amountPaise,
      authorizedAmountPaise: auth.amountPaise,
      authorizedQuoteHash: quote.quoteHash,
    });

    await prisma.driftCheck.create({
      data: {
        intentId: intent.id,
        quoteId: quote.id,
        decision: drift.decision,
        violationsJson: toCanonicalJson(drift.violations),
        rulesVersion: drift.rulesVersion,
        stage: 'pre_capture',
      },
    });

    if (drift.decision === 'block') {
      // Drift at capture means we hold money for something that no longer
      // matches what was approved. Give it back rather than keeping it.
      await releaseHold({
        config,
        gateway,
        intentId: intent.id,
        tenantId: identity.tenantId,
        mandateId: mandateRow.id,
        paymentId: auth.rzpPaymentId,
        amountPaise: auth.amountPaise,
        currency: auth.currency,
        reason: 'drift_at_capture',
        actorId: identity.agentId,
      });
      throw blockedByDrift(drift.violations);
    }

    // 3. The deadline, checked synchronously. No sweeper is consulted.
    const window = checkCaptureWindow({ captureDeadline: auth.captureDeadline, now });
    if (!window.ok) {
      await audit(config, {
        tenantId: identity.tenantId,
        actorType: 'system',
        actorId: 'capture-guard',
        eventType: 'capture.deadline_check_failed',
        intentId: intent.id,
        mandateId: mandateRow.id,
        payload: { code: window.code, deadline: window.deadline, msRemaining: window.msRemaining },
        occurredAt: now.toISOString(),
      });
      throw new ApiError(409, 'CAPTURE_WINDOW_CLOSED', window.message, {
        deadline: window.deadline,
        code: window.code,
      });
    }

    // 4. Claim the row. A conditional update is the concurrency guard: two
    //    simultaneous captures, and only one sees a count of 1.
    assertTransition('authorized', 'capturing');
    const claimed = await prisma.paymentIntent.updateMany({
      where: { id: intent.id, state: 'authorized' },
      data: { state: 'capturing' },
    });
    if (claimed.count !== 1) {
      throw conflict('Another capture is already in progress for this intent');
    }

    await audit(config, {
      tenantId: identity.tenantId,
      actorType: 'agent',
      actorId: identity.agentId,
      eventType: 'capture.requested',
      intentId: intent.id,
      mandateId: mandateRow.id,
      payload: {
        amountPaise: auth.amountPaise.toString(),
        msRemainingOnDeadline: window.msRemaining,
      },
      occurredAt: now.toISOString(),
    });

    // 5. Only now does money move.
    try {
      const payment = await gateway.capturePayment({
        paymentId: auth.rzpPaymentId,
        amountPaise: auth.amountPaise,
        currency: auth.currency,
      });

      const capturedAt = new Date();
      await prisma.$transaction([
        prisma.paymentIntent.update({
          where: { id: intent.id },
          data: { state: 'captured', capturedAmountPaise: auth.amountPaise },
        }),
        prisma.authorization.update({
          where: { intentId: intent.id },
          data: { capturedAt, rzpPaymentId: payment.id },
        }),
      ]);

      await audit(config, {
        tenantId: identity.tenantId,
        actorType: 'agent',
        actorId: identity.agentId,
        eventType: 'capture.succeeded',
        intentId: intent.id,
        mandateId: mandateRow.id,
        payload: { amountPaise: auth.amountPaise.toString(), rzpPaymentId: payment.id },
        occurredAt: capturedAt.toISOString(),
      });

      const body = {
        intentId: intent.id,
        state: 'captured',
        capturedAmountPaise: auth.amountPaise.toString(),
        rzpPaymentId: payment.id,
      };
      if (idem && !idem.replayed) await idem.complete(200, body, intent.id);
      return reply.send(body);
    } catch (err) {
      const ambiguous = isGatewayError(err) && err.requiresReconciliation;

      await audit(config, {
        tenantId: identity.tenantId,
        actorType: 'system',
        actorId: 'gateway',
        eventType: 'capture.failed',
        intentId: intent.id,
        mandateId: mandateRow.id,
        payload: {
          ambiguous,
          code: isGatewayError(err) ? err.code : 'UNKNOWN',
          message: err instanceof Error ? err.message : String(err),
        },
        occurredAt: new Date().toISOString(),
      });

      if (ambiguous) {
        // The outcome is unknown. Ask the gateway rather than guessing — and
        // leave the intent in `capturing` if even that fails.
        const outcome = await reconcileIntent({ config, gateway, intentId: intent.id });

        if (outcome.resolved && outcome.state === 'captured') {
          const body = {
            intentId: intent.id,
            state: 'captured',
            capturedAmountPaise: auth.amountPaise.toString(),
            note: 'The capture call failed but the gateway confirms the payment was captured.',
          };
          if (idem && !idem.replayed) await idem.complete(200, body, intent.id);
          return reply.send(body);
        }

        throw new ApiError(
          503,
          'CAPTURE_OUTCOME_UNKNOWN',
          'The capture outcome could not be determined. Do not retry; reconciliation will resolve it.',
          { reconcile: outcome },
        );
      }

      // A provable failure. The hold is intact, so go back to `authorized`.
      await prisma.paymentIntent.updateMany({
        where: { id: intent.id, state: 'capturing' },
        data: { state: 'authorized' },
      });
      throw new ApiError(502, 'CAPTURE_FAILED', 'The gateway refused the capture', {
        code: isGatewayError(err) ? err.code : 'UNKNOWN',
      });
    }
  });

  /** Give up an uncaptured hold. Full only — there is no partial release. */
  app.post('/v1/intents/:id/release', async (request, reply) => {
    const identity = await authenticateAgent(request);
    const { id } = request.params as { id: string };
    const parsed = releaseSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw badRequest('Invalid release payload');

    const intent = await prisma.paymentIntent.findFirst({
      where: { id, tenantId: identity.tenantId, agentId: identity.agentId },
      include: { authorization: true },
    });
    if (!intent) throw notFound('Intent');

    const auth = intent.authorization;
    if (!auth?.rzpPaymentId) throw conflict('This intent has no authorization to release');

    // The core state machine decides whether this is even legal, and refuses a
    // partial amount against an uncaptured hold.
    const reversal = checkReversal({
      state: intent.state as 'authorized',
      baseAmountPaise: auth.amountPaise,
      alreadyRefundedPaise: intent.refundedAmountPaise,
    });
    if (!reversal.ok) throw conflict(reversal.message, { code: reversal.code });
    if (reversal.kind !== 'release') {
      throw conflict('This payment is captured; use a refund, not a release');
    }

    const result = await releaseHold({
      config,
      gateway,
      intentId: intent.id,
      tenantId: identity.tenantId,
      mandateId: intent.mandateId,
      paymentId: auth.rzpPaymentId,
      amountPaise: auth.amountPaise,
      currency: auth.currency,
      reason: 'agent_requested',
      actorId: identity.agentId,
    });

    return reply.send({
      intentId: intent.id,
      state: 'released',
      method: result.method,
      note:
        result.method === 'gateway_expiry'
          ? 'The gateway does not support reversing this payment. The hold will lapse under the 3-day auto-refund; no money was captured.'
          : 'The hold was reversed at the gateway.',
    });
  });
}

/**
 * Release a hold and put the amount back on the mandate's cumulative ceiling.
 *
 * The USE is not returned — a released hold still consumed one of the mandate's
 * permitted attempts. Otherwise an agent could churn authorizations forever.
 */
async function releaseHold(args: {
  config: Config;
  gateway: PaymentGateway;
  intentId: string;
  tenantId: string;
  mandateId: string;
  paymentId: string;
  amountPaise: bigint;
  currency: string;
  reason: 'agent_requested' | 'drift_at_capture' | 'deadline_passed';
  actorId: string;
}) {
  const now = new Date();

  await audit(args.config, {
    tenantId: args.tenantId,
    actorType: args.actorId === 'system' ? 'system' : 'agent',
    actorId: args.actorId,
    eventType: 'authorization.release_requested',
    intentId: args.intentId,
    mandateId: args.mandateId,
    payload: { reason: args.reason, amountPaise: args.amountPaise.toString() },
    occurredAt: now.toISOString(),
  });

  const result = await args.gateway.releaseAuthorization({
    paymentId: args.paymentId,
    amountPaise: args.amountPaise,
    currency: args.currency,
  });

  await prisma.$transaction([
    prisma.paymentIntent.update({
      where: { id: args.intentId },
      data: { state: 'released' },
    }),
    prisma.authorization.update({
      where: { intentId: args.intentId },
      data: {
        releasedAt: now,
        releaseReason: args.reason,
        releaseMethod: result.method,
      },
    }),
    prisma.mandate.update({
      where: { id: args.mandateId },
      data: { cumulativeAuthorizedPaise: { decrement: args.amountPaise } },
    }),
  ]);

  await audit(args.config, {
    tenantId: args.tenantId,
    actorType: 'system',
    actorId: 'gateway',
    eventType: 'authorization.released',
    intentId: args.intentId,
    mandateId: args.mandateId,
    payload: {
      reason: args.reason,
      method: result.method,
      reversed: result.released,
      refundId: result.refund?.id ?? null,
    },
    occurredAt: new Date().toISOString(),
  });

  return result;
}

/** Exported so the webhook handler can set the deadline when the hold lands. */
export function deadlineFor(authorizedAt: Date, terms: MandateTerms, config: Config): Date {
  return computeCaptureDeadline(
    authorizedAt,
    Math.min(terms.captureDeadlineHours, config.captureDeadlineHours),
  );
}
