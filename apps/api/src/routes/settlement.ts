/**
 * Post-delivery endpoints.
 *
 * Three steps, deliberately separate:
 *
 *   /delivery  — record what arrived. No decision, no money.
 *   /settle    — run the rules. Produces a RECOMMENDATION only.
 *   /execute   — actually refund. Gated on either a human or an explicit
 *                autoRefundAllowed on the signed mandate.
 *
 * The split is the point. "The engine recommended a refund" and "money moved"
 * are different facts, and collapsing them would mean a rules change could
 * silently start moving money.
 */
import { isGatewayError, type PaymentGateway } from '@razortrust/adapters';
import {
  checkReversal,
  deliveryEvidenceSchema,
  evaluateSettlement,
  mandateTermsSchema,
  summariseSettlement,
} from '@razortrust/core';
import { prisma, toCanonicalJson } from '@razortrust/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { authenticateAgent, authenticatePrincipal, type Identity } from '../auth.js';
import { audit } from '../audit.js';
import type { Config } from '../config.js';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { getGateway } from '../gateway.js';
import { withIdempotency } from '../idempotency.js';

const recordDeliverySchema = z
  .object({
    evidence: z.unknown(),
    source: z.enum(['merchant_api', 'ai_structured']).default('merchant_api'),
    rawEvidence: z.record(z.unknown()).optional(),
  })
  .strict();

const executeSchema = z
  .object({
    /** Must match the recommendation exactly. Prevents a stale UI paying out. */
    confirmRefundAmountPaise: z.string().regex(/^\d+$/),
    reason: z.string().max(500).optional(),
  })
  .strict();

/** Either identity may read; only the listed one may act. */
async function anyIdentity(request: Parameters<typeof authenticateAgent>[0]): Promise<Identity> {
  try {
    return await authenticateAgent(request);
  } catch {
    return authenticatePrincipal(request);
  }
}

/** Load everything the settlement engine needs, verified. */
async function loadSettlementInputs(intentId: string, tenantId: string) {
  const intent = await prisma.paymentIntent.findFirst({
    where: { id: intentId, tenantId },
    include: { authorization: true },
  });
  if (!intent) throw notFound('Intent');

  const mandateRow = await prisma.mandate.findUnique({ where: { id: intent.mandateId } });
  if (!mandateRow) throw notFound('Mandate');

  const quote = await prisma.quote.findFirst({
    where: { intentId: intent.id },
    orderBy: { createdAt: 'desc' },
  });
  if (!quote) throw badRequest('No quote on this intent; nothing to settle against');

  return {
    intent,
    mandateRow,
    quote,
    // The SIGNED terms, not the denormalised columns. Settlement compares
    // against what the human actually approved.
    terms: mandateTermsSchema.parse(JSON.parse(mandateRow.termsJson)),
  };
}

export async function settlementRoutes(app: FastifyInstance, config: Config) {
  const gateway: PaymentGateway = getGateway(config);

  /** Record what actually arrived. Pure bookkeeping. */
  app.post('/v1/intents/:id/delivery', async (request, reply) => {
    const identity = await anyIdentity(request);
    const { id } = request.params as { id: string };
    const now = new Date();

    const parsed = recordDeliverySchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid delivery payload');

    const intent = await prisma.paymentIntent.findFirst({
      where: { id, tenantId: identity.tenantId },
    });
    if (!intent) throw notFound('Intent');

    // Validated here regardless of source. Evidence the AI structured faces
    // exactly the same schema as evidence from a merchant API.
    const evidence = deliveryEvidenceSchema.safeParse(parsed.data.evidence);
    if (!evidence.success) {
      throw badRequest('Delivery evidence is not valid', {
        issues: evidence.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }

    const stored = await prisma.delivery.create({
      data: {
        intentId: intent.id,
        trackingId: evidence.data.trackingId ?? null,
        carrier: evidence.data.carrier ?? null,
        status: evidence.data.status,
        shippedAt: evidence.data.shippedAt ? new Date(evidence.data.shippedAt) : null,
        deliveredAt: evidence.data.deliveredAt ? new Date(evidence.data.deliveredAt) : null,
        lineItemsJson: toCanonicalJson(evidence.data.lineItems),
        rawEvidenceJson: toCanonicalJson(parsed.data.rawEvidence ?? {}),
        source: parsed.data.source,
      },
    });

    await audit(config, {
      tenantId: identity.tenantId,
      actorType: identity.kind === 'agent' ? 'agent' : 'human',
      actorId: identity.kind === 'agent' ? identity.agentId : identity.principalId,
      eventType: 'delivery.recorded',
      intentId: intent.id,
      mandateId: intent.mandateId,
      payload: {
        deliveryId: stored.id,
        status: evidence.data.status,
        trackingId: evidence.data.trackingId ?? null,
        source: parsed.data.source,
      },
      occurredAt: now.toISOString(),
    });

    return reply.status(201).send({
      deliveryId: stored.id,
      intentId: intent.id,
      status: evidence.data.status,
      nextStep: `POST /v1/intents/${intent.id}/settle`,
    });
  });

  /**
   * Run the rules. Produces a recommendation and nothing else.
   *
   * Safe to call repeatedly: each run writes a new settlement row rather than
   * editing the last, so the sequence of recommendations stays readable.
   */
  app.post('/v1/intents/:id/settle', async (request, reply) => {
    const identity = await anyIdentity(request);
    const { id } = request.params as { id: string };
    const now = new Date();

    const { intent, mandateRow, quote, terms } = await loadSettlementInputs(id, identity.tenantId);

    const delivery = await prisma.delivery.findFirst({
      where: { intentId: intent.id },
      orderBy: { recordedAt: 'desc' },
    });
    if (!delivery) throw badRequest('No delivery evidence recorded for this intent');

    const result = evaluateSettlement({
      mandate: terms,
      quote: JSON.parse(quote.structuredJson),
      evidence: {
        evidenceVersion: 1,
        status: delivery.status,
        ...(delivery.trackingId ? { trackingId: delivery.trackingId } : {}),
        ...(delivery.carrier ? { carrier: delivery.carrier } : {}),
        ...(delivery.shippedAt ? { shippedAt: delivery.shippedAt.toISOString() } : {}),
        ...(delivery.deliveredAt ? { deliveredAt: delivery.deliveredAt.toISOString() } : {}),
        lineItems: JSON.parse(delivery.lineItemsJson),
      },
      now,
      capturedAmountPaise: intent.capturedAmountPaise ?? 0n,
      alreadyRefundedPaise: intent.refundedAmountPaise,
    });

    const stored = await prisma.settlement.create({
      data: {
        intentId: intent.id,
        deliveryId: delivery.id,
        recommendation: result.recommendation,
        refundAmountPaise: result.refundAmountPaise,
        reasonsJson: toCanonicalJson(result.reasons),
        rulesVersion: result.rulesVersion,
      },
    });

    await audit(config, {
      tenantId: identity.tenantId,
      actorType: 'system',
      actorId: 'settlement-engine',
      eventType: 'settlement.evaluated',
      intentId: intent.id,
      mandateId: mandateRow.id,
      payload: {
        settlementId: stored.id,
        recommendation: result.recommendation,
        refundAmountPaise: result.refundAmountPaise.toString(),
        rulesVersion: result.rulesVersion,
        autoExecutable: result.autoExecutable,
        rules: result.reasons.map((r) => r.ruleId),
      },
      occurredAt: now.toISOString(),
    });

    return reply.send({
      settlementId: stored.id,
      intentId: intent.id,
      recommendation: result.recommendation,
      refundAmountPaise: result.refundAmountPaise.toString(),
      reasons: result.reasons,
      rulesVersion: result.rulesVersion,
      summary: summariseSettlement(result),
      autoExecutable: result.autoExecutable,
      note:
        result.recommendation === 'escalate'
          ? 'The evidence needs human judgement. This recommendation carries no amount and cannot be auto-executed.'
          : result.autoExecutable
            ? 'The signed mandate permits RazorTrust to execute this refund without a human.'
            : 'A human must approve this before any money moves.',
    });
  });

  /**
   * Actually refund.
   *
   * A principal may always execute. An agent may only execute a recommendation
   * the signed mandate marked auto-executable — and never an escalation.
   */
  app.post('/v1/settlements/:id/execute', async (request, reply) => {
    const identity = await anyIdentity(request);
    const { id } = request.params as { id: string };
    const now = new Date();

    const parsed = executeSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest('confirmRefundAmountPaise is required and must be an integer paise string');
    }

    const idem = await withIdempotency({
      request,
      identity,
      endpoint: 'POST /v1/settlements/:id/execute',
      body: parsed.data,
      required: true,
    });
    if (idem?.replayed) return reply.status(idem.status).send(idem.body);

    const settlement = await prisma.settlement.findUnique({
      where: { id },
      include: { intent: { include: { authorization: true } } },
    });
    if (!settlement || settlement.intent.tenantId !== identity.tenantId) {
      throw notFound('Settlement');
    }
    if (settlement.executedAt) {
      throw conflict('This settlement has already been executed');
    }

    const intent = settlement.intent;
    const mandateRow = await prisma.mandate.findUnique({ where: { id: intent.mandateId } });
    if (!mandateRow) throw notFound('Mandate');
    const terms = mandateTermsSchema.parse(JSON.parse(mandateRow.termsJson));

    if (settlement.recommendation === 'escalate' || settlement.recommendation === 'none') {
      throw conflict(
        `A "${settlement.recommendation}" recommendation carries no refund to execute`,
      );
    }

    // An agent cannot approve its own refund unless the human said so when
    // they signed the mandate.
    if (identity.kind === 'agent' && !terms.autoRefundAllowed) {
      throw forbidden(
        'This mandate requires a human to approve refunds; an agent may not execute this settlement',
      );
    }

    // A human may only approve refunds against a mandate they themselves
    // signed. Sharing a tenant is not consent to move someone else's money.
    if (identity.kind === 'human' && mandateRow.principalId !== identity.principalId) {
      throw forbidden(
        'Only the principal who signed this mandate may approve refunds against it',
      );
    }

    // The caller must be acting on the amount it was actually shown. A stale
    // console tab cannot pay out yesterday's number.
    if (BigInt(parsed.data.confirmRefundAmountPaise) !== settlement.refundAmountPaise) {
      throw conflict('Confirmed amount does not match the recommendation', {
        recommended: settlement.refundAmountPaise.toString(),
        confirmed: parsed.data.confirmRefundAmountPaise,
      });
    }

    // Core has the final word on whether this reversal is even legal.
    const reversal = checkReversal({
      state: intent.state as 'captured',
      baseAmountPaise: intent.capturedAmountPaise ?? 0n,
      alreadyRefundedPaise: intent.refundedAmountPaise,
      requestedAmountPaise: settlement.refundAmountPaise,
    });
    if (!reversal.ok) throw conflict(reversal.message, { code: reversal.code });
    if (reversal.kind !== 'refund') {
      throw conflict('This payment was never captured; release the hold instead of refunding');
    }

    const auth = intent.authorization;
    if (!auth?.rzpPaymentId) throw conflict('No gateway payment to refund');

    await audit(config, {
      tenantId: identity.tenantId,
      actorType: identity.kind === 'agent' ? 'agent' : 'human',
      actorId: identity.kind === 'agent' ? identity.agentId : identity.principalId,
      eventType: 'refund.requested',
      intentId: intent.id,
      mandateId: mandateRow.id,
      payload: {
        settlementId: settlement.id,
        amountPaise: reversal.amountPaise.toString(),
        recommendation: settlement.recommendation,
        approvedBy: identity.kind,
      },
      occurredAt: now.toISOString(),
    });

    const isPartial = settlement.recommendation === 'partial_refund';

    const refundRow = await prisma.refund.create({
      data: {
        intentId: intent.id,
        amountPaise: reversal.amountPaise,
        kind: isPartial ? 'partial' : 'full',
        status: 'pending',
        reason: parsed.data.reason ?? settlement.recommendation,
        initiatedBy: identity.kind === 'agent' ? 'system' : 'human',
      },
    });

    try {
      const refund = await gateway.createRefund({
        paymentId: auth.rzpPaymentId,
        amountPaise: reversal.amountPaise,
        currency: auth.currency,
        isPartial,
        notes: { settlementId: settlement.id, intentId: intent.id },
      });

      const totalRefunded = intent.refundedAmountPaise + reversal.amountPaise;
      const capturedTotal = intent.capturedAmountPaise ?? 0n;

      await prisma.$transaction([
        prisma.refund.update({
          where: { id: refundRow.id },
          data: { rzpRefundId: refund.id, status: 'processed', processedAt: new Date() },
        }),
        prisma.paymentIntent.update({
          where: { id: intent.id },
          data: {
            refundedAmountPaise: totalRefunded,
            state: totalRefunded >= capturedTotal ? 'refunded' : 'partially_refunded',
          },
        }),
        prisma.settlement.update({
          where: { id: settlement.id },
          data: {
            executedAt: new Date(),
            executedBy: identity.kind === 'agent' ? identity.agentId : identity.principalId,
            executedRefundId: refundRow.id,
          },
        }),
      ]);

      await audit(config, {
        tenantId: identity.tenantId,
        actorType: 'gateway',
        actorId: 'razorpay',
        eventType: 'refund.succeeded',
        intentId: intent.id,
        mandateId: mandateRow.id,
        payload: {
          settlementId: settlement.id,
          refundId: refund.id,
          amountPaise: reversal.amountPaise.toString(),
          kind: isPartial ? 'partial' : 'full',
        },
        occurredAt: new Date().toISOString(),
      });

      const body = {
        settlementId: settlement.id,
        intentId: intent.id,
        refundId: refund.id,
        amountPaise: reversal.amountPaise.toString(),
        kind: isPartial ? 'partial' : 'full',
        state: totalRefunded >= capturedTotal ? 'refunded' : 'partially_refunded',
      };
      if (idem && !idem.replayed) await idem.complete(200, body, intent.id);
      return reply.send(body);
    } catch (err) {
      await prisma.refund.update({
        where: { id: refundRow.id },
        data: { status: 'failed' },
      });

      await audit(config, {
        tenantId: identity.tenantId,
        actorType: 'system',
        actorId: 'gateway',
        eventType: 'refund.failed',
        intentId: intent.id,
        mandateId: mandateRow.id,
        payload: {
          settlementId: settlement.id,
          code: isGatewayError(err) ? err.code : 'UNKNOWN',
          message: err instanceof Error ? err.message : String(err),
        },
        occurredAt: new Date().toISOString(),
      });

      throw new ApiError(502, 'REFUND_FAILED', 'The gateway refused the refund', {
        code: isGatewayError(err) ? err.code : 'UNKNOWN',
      });
    }
  });

  app.get('/v1/intents/:id/settlements', async (request, reply) => {
    const identity = await anyIdentity(request);
    const { id } = request.params as { id: string };

    const intent = await prisma.paymentIntent.findFirst({
      where: { id, tenantId: identity.tenantId },
      include: {
        settlements: { orderBy: { evaluatedAt: 'desc' } },
        deliveries: { orderBy: { recordedAt: 'desc' }, take: 1 },
      },
    });
    if (!intent) throw notFound('Intent');

    return reply.send({
      intentId: intent.id,
      capturedAmountPaise: intent.capturedAmountPaise?.toString() ?? null,
      refundedAmountPaise: intent.refundedAmountPaise.toString(),
      latestDelivery: intent.deliveries[0]
        ? {
            deliveryId: intent.deliveries[0].id,
            status: intent.deliveries[0].status,
            deliveredAt: intent.deliveries[0].deliveredAt?.toISOString() ?? null,
          }
        : null,
      settlements: intent.settlements.map((s) => ({
        settlementId: s.id,
        recommendation: s.recommendation,
        refundAmountPaise: s.refundAmountPaise.toString(),
        reasons: JSON.parse(s.reasonsJson),
        rulesVersion: s.rulesVersion,
        evaluatedAt: s.evaluatedAt.toISOString(),
        executedAt: s.executedAt?.toISOString() ?? null,
        executedBy: s.executedBy,
      })),
    });
  });
}
