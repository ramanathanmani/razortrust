/**
 * Gateway webhooks.
 *
 * Three things this handler has to get right, all of which are easy to get
 * wrong:
 *
 *   1. RAW BODY. The signature is an HMAC over the exact bytes received.
 *      Fastify parses JSON into an object by default, and re-serialising it
 *      changes whitespace and key order, so the HMAC will not match. A
 *      raw-body parser is registered for this route only.
 *
 *   2. REPLAY. Razorpay retries. A replayed `payment.captured` must not
 *      advance state twice. The schema enforces uniqueness on both the
 *      provider event id and the payload hash.
 *
 *   3. ORDERING. A webhook can arrive BEFORE our own API call returns, and
 *      out of order relative to other events. So each handler is written as
 *      "make the record match this fact", not "advance the state machine".
 */
import { fromGatewayAmount, type NormalisedWebhookEvent } from '@razortrust/adapters';
import { mandateTermsSchema, sha256Hex } from '@razortrust/core';
import { prisma } from '@razortrust/db';
import type { FastifyInstance } from 'fastify';

import { audit } from '../audit.js';
import type { Config } from '../config.js';
import { getGateway } from '../gateway.js';
import { deadlineFor } from './payments.js';

export async function webhookRoutes(app: FastifyInstance, config: Config) {
  const gateway = getGateway(config);

  // Keep the exact bytes. Without this, signature verification cannot work.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => done(null, body),
  );

  app.post('/v1/webhooks/razorpay', async (request, reply) => {
    const rawBody = typeof request.body === 'string' ? request.body : '';
    const signature = String(request.headers['x-razorpay-signature'] ?? '');
    const providerEventId = (request.headers['x-razorpay-event-id'] as string | undefined) ?? null;
    const payloadHash = sha256Hex(rawBody);

    const signatureValid = gateway.verifyWebhookSignature(rawBody, signature);
    const event = gateway.parseWebhook(rawBody);

    // Resolve the tenant from our own records, never from the payload.
    const tenantId = await tenantForEvent(event);

    // Fast path for the common case: the gateway retried something we already
    // have. The unique constraints below remain the actual authority — this
    // only spares the logs a stack trace on every routine retry.
    const seen = await prisma.webhookEvent.findFirst({
      where: {
        provider: 'razorpay',
        OR: [...(providerEventId ? [{ providerEventId }] : []), { payloadHash }],
      },
      select: { id: true },
    });
    if (seen) {
      if (tenantId) {
        await audit(config, {
          tenantId,
          actorType: 'gateway',
          actorId: 'razorpay',
          eventType: 'webhook.replay_rejected',
          payload: { eventType: event.eventType, providerEventId, payloadHash },
          occurredAt: new Date().toISOString(),
        });
      }
      return reply.status(200).send({ status: 'duplicate_ignored' });
    }

    // Record the receipt, and let the unique constraints settle any race the
    // check above lost.
    try {
      await prisma.webhookEvent.create({
        data: {
          tenantId: tenantId ?? 'unknown',
          provider: 'razorpay',
          providerEventId,
          payloadHash,
          eventType: event.eventType,
          rawBody,
          signatureValid,
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        if (tenantId) {
          await audit(config, {
            tenantId,
            actorType: 'gateway',
            actorId: 'razorpay',
            eventType: 'webhook.replay_rejected',
            payload: { eventType: event.eventType, providerEventId, payloadHash },
            occurredAt: new Date().toISOString(),
          });
        }
        // 200, so the gateway stops retrying something we already have.
        return reply.status(200).send({ status: 'duplicate_ignored' });
      }
      throw err;
    }

    // An unsigned webhook is recorded and then ignored. Recording it is
    // deliberate: a burst of bad signatures is worth being able to see.
    if (!signatureValid) {
      return reply.status(400).send({ error: 'INVALID_SIGNATURE' });
    }

    if (!tenantId) {
      return reply.status(200).send({ status: 'ignored_unknown_intent' });
    }

    await audit(config, {
      tenantId,
      actorType: 'gateway',
      actorId: 'razorpay',
      eventType: 'webhook.received',
      payload: { eventType: event.eventType, providerEventId, paymentId: event.paymentId },
      occurredAt: new Date().toISOString(),
    });

    try {
      await handleEvent(config, tenantId, event);
      await prisma.webhookEvent.updateMany({
        where: { provider: 'razorpay', payloadHash },
        data: { processedAt: new Date() },
      });
    } catch (err) {
      await prisma.webhookEvent.updateMany({
        where: { provider: 'razorpay', payloadHash },
        data: { processingError: err instanceof Error ? err.message : String(err) },
      });
      // 500 so the gateway retries; the replay guard makes that safe.
      return reply.status(500).send({ error: 'PROCESSING_FAILED' });
    }

    return reply.send({ status: 'ok' });
  });
}

async function tenantForEvent(event: NormalisedWebhookEvent): Promise<string | null> {
  if (!event.orderId && !event.paymentId) return null;

  const auth = await prisma.authorization.findFirst({
    where: {
      OR: [
        ...(event.orderId ? [{ rzpOrderId: event.orderId }] : []),
        ...(event.paymentId ? [{ rzpPaymentId: event.paymentId }] : []),
      ],
    },
    include: { intent: { select: { tenantId: true } } },
  });

  return auth?.intent.tenantId ?? null;
}

async function handleEvent(
  config: Config,
  tenantId: string,
  event: NormalisedWebhookEvent,
): Promise<void> {
  const payment = event.payment;
  if (!payment) return;

  const auth = await prisma.authorization.findFirst({
    where: { OR: [{ rzpOrderId: payment.order_id }, { rzpPaymentId: payment.id }] },
    include: { intent: true },
  });
  if (!auth) return;

  const now = new Date();

  switch (event.eventType) {
    case 'payment.authorized': {
      // The human finished checkout. This is where the hold — and therefore the
      // capture deadline — actually begins.
      if (auth.authorizedAt) return; // already recorded; webhooks repeat

      const mandate = await prisma.mandate.findUnique({ where: { id: auth.intent.mandateId } });
      if (!mandate) return;

      const terms = mandateTermsSchema.parse(JSON.parse(mandate.termsJson));
      const authorizedAt = payment.created_at ? new Date(payment.created_at * 1000) : now;
      const captureDeadline = deadlineFor(authorizedAt, terms, config);

      await prisma.$transaction([
        prisma.authorization.update({
          where: { intentId: auth.intentId },
          data: {
            rzpPaymentId: payment.id,
            authorizedAt,
            captureDeadline,
            method: payment.method ?? null,
          },
        }),
        prisma.paymentIntent.update({
          where: { id: auth.intentId },
          data: {
            state: 'authorized',
            authorizedAmountPaise: fromGatewayAmount(payment.amount),
          },
        }),
      ]);

      await audit(config, {
        tenantId,
        actorType: 'gateway',
        actorId: 'razorpay',
        eventType: 'authorization.succeeded',
        intentId: auth.intentId,
        mandateId: auth.intent.mandateId,
        payload: {
          rzpPaymentId: payment.id,
          amountPaise: String(payment.amount),
          authorizedAt: authorizedAt.toISOString(),
          captureDeadline: captureDeadline.toISOString(),
          captureMode: 'manual',
        },
        occurredAt: now.toISOString(),
      });
      return;
    }

    case 'payment.captured': {
      // May arrive before our own capture call returns. Treat it as
      // confirmation of a fact, not as a transition to perform.
      if (auth.capturedAt) return;

      await prisma.$transaction([
        prisma.authorization.update({
          where: { intentId: auth.intentId },
          data: { capturedAt: now, rzpPaymentId: payment.id },
        }),
        prisma.paymentIntent.update({
          where: { id: auth.intentId },
          data: { state: 'captured', capturedAmountPaise: fromGatewayAmount(payment.amount) },
        }),
      ]);

      await audit(config, {
        tenantId,
        actorType: 'gateway',
        actorId: 'razorpay',
        eventType: 'capture.succeeded',
        intentId: auth.intentId,
        mandateId: auth.intent.mandateId,
        payload: { viaWebhook: true, rzpPaymentId: payment.id, amountPaise: String(payment.amount) },
        occurredAt: now.toISOString(),
      });
      return;
    }

    case 'payment.failed': {
      await prisma.$transaction([
        prisma.authorization.update({
          where: { intentId: auth.intentId },
          data: {
            failureCode: payment.error_code ?? 'UNKNOWN',
            failureMessage: payment.error_description ?? null,
          },
        }),
        prisma.paymentIntent.updateMany({
          where: { id: auth.intentId, state: { in: ['awaiting_authorization', 'capturing'] } },
          data: { state: 'failed' },
        }),
      ]);

      await audit(config, {
        tenantId,
        actorType: 'gateway',
        actorId: 'razorpay',
        eventType: 'authorization.failed',
        intentId: auth.intentId,
        mandateId: auth.intent.mandateId,
        payload: { code: payment.error_code ?? 'UNKNOWN' },
        occurredAt: now.toISOString(),
      });
      return;
    }

    case 'refund.processed': {
      const refunded = fromGatewayAmount(payment.amount_refunded);
      const wasCaptured = auth.capturedAt !== null;

      await prisma.$transaction([
        prisma.paymentIntent.update({
          where: { id: auth.intentId },
          data: {
            refundedAmountPaise: refunded,
            state: wasCaptured
              ? refunded >= auth.amountPaise
                ? 'refunded'
                : 'partially_refunded'
              : 'released',
          },
        }),
        ...(wasCaptured
          ? []
          : [
              // An uncaptured hold that came back: either our reversal or the
              // gateway's own 3-day auto-refund.
              prisma.authorization.update({
                where: { intentId: auth.intentId },
                data: {
                  releasedAt: auth.releasedAt ?? now,
                  releaseReason: auth.releaseReason ?? 'gateway_auto_refund',
                  releaseMethod: auth.releaseMethod ?? 'gateway_expiry',
                },
              }),
            ]),
      ]);

      await audit(config, {
        tenantId,
        actorType: 'gateway',
        actorId: 'razorpay',
        eventType: wasCaptured ? 'refund.succeeded' : 'authorization.auto_refunded_by_gateway',
        intentId: auth.intentId,
        mandateId: auth.intent.mandateId,
        payload: { refundedPaise: refunded.toString(), wasCaptured },
        occurredAt: now.toISOString(),
      });
      return;
    }

    default:
      return;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'P2002'
  );
}
