/**
 * Intent endpoints — the agent side.
 *
 * An agent can create an intent, attach a quote, and ask for a decision. It
 * cannot authorise, capture, or refund anything from here, and it never sees a
 * payment instrument. The most it can obtain is a verdict.
 *
 * Note what the agent does NOT get to supply: the tenant, the cumulative spend
 * so far, or the current time. All three come from the server, because all
 * three are things a rule depends on.
 */
import {
  evaluateDrift,
  hashQuote,
  mandateTermsSchema,
  sha256Hex,
  structuredQuoteSchema,
  verifyMandate,
} from '@razortrust/core';
import { prisma, toCanonicalJson } from '@razortrust/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { authenticateAgent } from '../auth.js';
import { audit } from '../audit.js';
import type { Config } from '../config.js';
import { ApiError, badRequest, blockedByDrift, mandateRejected, notFound } from '../errors.js';
import { getStructurer } from '../gateway.js';
import { withIdempotency } from '../idempotency.js';

const createIntentSchema = z
  .object({
    mandateId: z.string().uuid(),
    merchantId: z.string().min(1).max(128),
    requestedAmountPaise: z.string().regex(/^\d+$/).optional(),
  })
  .strict();

const submitQuoteSchema = z
  .object({
    /** A merchant's structured quote. Validated against the same schema either way. */
    structuredQuote: z.unknown(),
    source: z.enum(['merchant_api', 'ai_structured']).default('merchant_api'),
    rawInput: z.string().max(100_000).optional(),
    aiModel: z.string().max(128).optional(),
    aiConfidence: z.number().int().min(0).max(100).optional(),
  })
  .strict();

/** Load a mandate and run the full core verification against it. */
async function loadVerifiedMandate(args: {
  mandateId: string;
  tenantId: string;
  agentId: string;
  now: Date;
}) {
  const row = await prisma.mandate.findFirst({
    where: { id: args.mandateId, tenantId: args.tenantId },
  });
  if (!row) throw notFound('Mandate');

  const verification = verifyMandate({
    mandate: {
      terms: mandateTermsSchema.parse(JSON.parse(row.termsJson)),
      termsHash: row.termsHash,
      signature: row.signature ?? '',
      signedByPublicKeyPem: row.signedByPublicKeyPem ?? '',
      signedAt: row.signedAt?.toISOString() ?? '',
    },
    state: {
      status: row.status as 'active',
      usesCount: row.usesCount,
      cumulativeAuthorizedPaise: row.cumulativeAuthorizedPaise,
      ...(row.revokedAt ? { revokedAt: row.revokedAt.toISOString() } : {}),
    },
    presentedBy: { tenantId: args.tenantId, agentId: args.agentId },
    now: args.now,
  });

  return { row, verification };
}

const structureFromTextSchema = z
  .object({
    /** An email body, an HTML invoice, a chat transcript — whatever arrived. */
    rawInput: z.string().min(1).max(100_000),
  })
  .strict();

export async function intentRoutes(app: FastifyInstance, config: Config) {
  const structurer = getStructurer(config);

  /** Open an intent against a mandate. No money is touched. */
  app.post('/v1/intents', async (request, reply) => {
    const identity = await authenticateAgent(request);
    const now = new Date();

    const parsed = createIntentSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest('Invalid intent payload', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }

    const idem = await withIdempotency({
      request,
      identity,
      endpoint: 'POST /v1/intents',
      body: parsed.data,
      required: true,
    });
    if (idem?.replayed) return reply.status(idem.status).send(idem.body);

    const { row, verification } = await loadVerifiedMandate({
      mandateId: parsed.data.mandateId,
      tenantId: identity.tenantId,
      agentId: identity.agentId,
      now,
    });

    if (!verification.ok) {
      await audit(config, {
        tenantId: identity.tenantId,
        actorType: 'agent',
        actorId: identity.agentId,
        eventType: 'mandate.verification_failed',
        mandateId: row.id,
        payload: { failures: verification.failures.map((f) => f.code) },
        occurredAt: now.toISOString(),
      });
      throw mandateRejected(verification.failures);
    }

    const merchant = await prisma.merchant.findFirst({
      where: { tenantId: identity.tenantId, externalRef: parsed.data.merchantId },
    });
    if (!merchant) throw badRequest(`Unknown merchant "${parsed.data.merchantId}"`);

    const intent = await prisma.paymentIntent.create({
      data: {
        tenantId: identity.tenantId,
        mandateId: row.id,
        agentId: identity.agentId,
        merchantId: merchant.id,
        state: 'created',
        mandateHashAtCreate: row.termsHash,
        currency: row.currency,
        ...(parsed.data.requestedAmountPaise
          ? { requestedAmountPaise: BigInt(parsed.data.requestedAmountPaise) }
          : {}),
      },
    });

    await audit(config, {
      tenantId: identity.tenantId,
      actorType: 'agent',
      actorId: identity.agentId,
      eventType: 'intent.created',
      mandateId: row.id,
      intentId: intent.id,
      payload: { merchantId: parsed.data.merchantId, mandateHash: row.termsHash },
      occurredAt: now.toISOString(),
    });

    const body = {
      intentId: intent.id,
      state: intent.state,
      mandateId: row.id,
      mandateHashAtCreate: row.termsHash,
      merchantId: parsed.data.merchantId,
    };
    if (idem && !idem.replayed) await idem.complete(201, body, intent.id);
    return reply.status(201).send(body);
  });

  /** Attach the merchant's final quote. Still no money. */
  app.post('/v1/intents/:id/quote', async (request, reply) => {
    const identity = await authenticateAgent(request);
    const { id } = request.params as { id: string };
    const now = new Date();

    const parsed = submitQuoteSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Invalid quote payload');

    const intent = await prisma.paymentIntent.findFirst({
      where: { id, tenantId: identity.tenantId, agentId: identity.agentId },
      include: { merchant: true },
    });
    if (!intent) throw notFound('Intent');
    if (intent.state !== 'created' && intent.state !== 'quoted') {
      throw badRequest(`Cannot attach a quote to an intent in state "${intent.state}"`);
    }

    // Validate here rather than trusting the caller's `source`. A quote that
    // came from the AI adapter and a quote that came from a merchant API face
    // exactly the same schema.
    const quote = structuredQuoteSchema.safeParse(parsed.data.structuredQuote);
    if (!quote.success) {
      await audit(config, {
        tenantId: identity.tenantId,
        actorType: 'agent',
        actorId: identity.agentId,
        eventType: parsed.data.source === 'ai_structured' ? 'quote.ai_rejected' : 'quote.submitted',
        intentId: intent.id,
        mandateId: intent.mandateId,
        payload: {
          accepted: false,
          issues: quote.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        },
        occurredAt: now.toISOString(),
      });
      throw badRequest('Structured quote is not valid', {
        issues: quote.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }

    const quoteHash = hashQuote(quote.data);

    const stored = await prisma.quote.create({
      data: {
        intentId: intent.id,
        merchantId: intent.merchantId,
        source: parsed.data.source,
        rawInput: parsed.data.rawInput ?? null,
        structuredJson: toCanonicalJson(quote.data),
        quoteHash,
        totalPaise: quote.data.totalPaise,
        currency: quote.data.currency,
        aiModel: parsed.data.aiModel ?? null,
        aiConfidence: parsed.data.aiConfidence ?? null,
      },
    });

    await prisma.paymentIntent.update({ where: { id: intent.id }, data: { state: 'quoted' } });

    await audit(config, {
      tenantId: identity.tenantId,
      actorType: 'agent',
      actorId: identity.agentId,
      eventType:
        parsed.data.source === 'ai_structured' ? 'quote.ai_structured' : 'quote.submitted',
      intentId: intent.id,
      mandateId: intent.mandateId,
      payload: {
        quoteId: stored.id,
        quoteHash,
        totalPaise: quote.data.totalPaise.toString(),
        source: parsed.data.source,
        ...(parsed.data.aiModel ? { aiModel: parsed.data.aiModel } : {}),
      },
      occurredAt: now.toISOString(),
    });

    return reply.status(201).send({
      quoteId: stored.id,
      quoteHash,
      intentId: intent.id,
      state: 'quoted',
      totalPaise: quote.data.totalPaise.toString(),
    });
  });

  /**
   * The decision.
   *
   * Deterministic, side-effect-free apart from the audit trail. An agent can
   * call this as often as it likes; a `block` never becomes an `allow` because
   * the agent asked again.
   */
  app.post('/v1/intents/:id/check', async (request, reply) => {
    const identity = await authenticateAgent(request);
    const { id } = request.params as { id: string };
    const now = new Date();

    const intent = await prisma.paymentIntent.findFirst({
      where: { id, tenantId: identity.tenantId, agentId: identity.agentId },
    });
    if (!intent) throw notFound('Intent');

    const quote = await prisma.quote.findFirst({
      where: { intentId: intent.id },
      orderBy: { createdAt: 'desc' },
    });
    if (!quote) throw badRequest('No quote attached to this intent yet');

    const { row, verification } = await loadVerifiedMandate({
      mandateId: intent.mandateId,
      tenantId: identity.tenantId,
      agentId: identity.agentId,
      now,
    });

    // The mandate is re-verified here, not just at intent creation. It may have
    // been revoked or expired since.
    if (!verification.ok) {
      await audit(config, {
        tenantId: identity.tenantId,
        actorType: 'agent',
        actorId: identity.agentId,
        eventType: 'mandate.verification_failed',
        intentId: intent.id,
        mandateId: row.id,
        payload: { failures: verification.failures.map((f) => f.code), stage: 'pre_authorization' },
        occurredAt: now.toISOString(),
      });
      throw mandateRejected(verification.failures);
    }

    const result = evaluateDrift({
      mandate: verification.terms,
      quote: JSON.parse(quote.structuredJson),
      stage: 'pre_authorization',
      now,
      cumulativeAuthorizedPaise: row.cumulativeAuthorizedPaise,
    });

    await prisma.driftCheck.create({
      data: {
        intentId: intent.id,
        quoteId: quote.id,
        decision: result.decision,
        violationsJson: toCanonicalJson(result.violations),
        rulesVersion: result.rulesVersion,
        stage: result.stage,
      },
    });

    await audit(config, {
      tenantId: identity.tenantId,
      actorType: 'agent',
      actorId: identity.agentId,
      eventType: result.decision === 'allow' ? 'drift.evaluated' : 'drift.blocked',
      intentId: intent.id,
      mandateId: row.id,
      payload: {
        decision: result.decision,
        rulesVersion: result.rulesVersion,
        quoteHash: result.quoteHash,
        violations: result.violations.map((v) => v.ruleId),
      },
      occurredAt: now.toISOString(),
    });

    if (result.decision === 'block') {
      await prisma.paymentIntent.update({
        where: { id: intent.id },
        data: { state: 'blocked', blockedReasonJson: toCanonicalJson(result.violations) },
      });
      throw blockedByDrift(result.violations);
    }

    return reply.send({
      intentId: intent.id,
      decision: 'allow',
      quoteHash: result.quoteHash,
      rulesVersion: result.rulesVersion,
      evaluatedAt: result.evaluatedAt,
      /** Authorization is step 7; this endpoint decides, it does not pay. */
      nextStep: 'POST /v1/intents/:id/authorize',
    });
  });

  /**
   * Turn messy merchant text into a structured quote.
   *
   * This is the ONLY place an AI model touches the payment path, and its output
   * has no more authority than a merchant API's would: it lands in the same
   * schema, faces the same drift rules, and is rejected outright if any figure
   * it reports cannot be found in the source text.
   *
   * A model that abstains, refuses, or is unreachable produces no quote. It
   * never produces a guess, and it never lets an earlier quote stand in.
   */
  app.post('/v1/intents/:id/quote/from-text', async (request, reply) => {
    const identity = await authenticateAgent(request);
    const { id } = request.params as { id: string };
    const now = new Date();

    const parsed = structureFromTextSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('rawInput is required (1-100000 characters)');

    const intent = await prisma.paymentIntent.findFirst({
      where: { id, tenantId: identity.tenantId, agentId: identity.agentId },
      include: { merchant: true },
    });
    if (!intent) throw notFound('Intent');
    if (intent.state !== 'created' && intent.state !== 'quoted') {
      throw badRequest(`Cannot attach a quote to an intent in state "${intent.state}"`);
    }

    const result = await structurer.structureQuote({
      rawInput: parsed.data.rawInput,
      // From our records, never from the text. Merchant identity decides
      // whether the mandate permits this purchase at all.
      merchantId: intent.merchant.externalRef,
      now,
    });

    if (!result.ok) {
      await audit(config, {
        tenantId: identity.tenantId,
        actorType: 'system',
        actorId: 'ai-structurer',
        eventType: 'quote.ai_rejected',
        intentId: intent.id,
        mandateId: intent.mandateId,
        payload: {
          model: result.model,
          code: result.rejection.code,
          message: result.rejection.message,
          ...(result.rejection.detail ? { detail: [...result.rejection.detail] } : {}),
        },
        occurredAt: now.toISOString(),
      });

      throw new ApiError(
        422,
        'QUOTE_STRUCTURING_REJECTED',
        'Could not read a trustworthy quote from this input',
        { code: result.rejection.code, reason: result.rejection.message, detail: result.rejection.detail },
      );
    }

    // Already validated against structuredQuoteSchema inside the adapter; parse
    // again here so this route never trusts an upstream claim.
    const quote = structuredQuoteSchema.parse(result.quote);
    const quoteHash = hashQuote(quote);

    const stored = await prisma.quote.create({
      data: {
        intentId: intent.id,
        merchantId: intent.merchantId,
        source: 'ai_structured',
        rawInput: parsed.data.rawInput,
        structuredJson: toCanonicalJson(quote),
        quoteHash,
        totalPaise: quote.totalPaise,
        currency: quote.currency,
        aiModel: result.model,
        aiConfidence: result.confidence,
      },
    });

    await prisma.paymentIntent.update({ where: { id: intent.id }, data: { state: 'quoted' } });

    await audit(config, {
      tenantId: identity.tenantId,
      actorType: 'system',
      actorId: 'ai-structurer',
      eventType: 'quote.ai_structured',
      intentId: intent.id,
      mandateId: intent.mandateId,
      payload: {
        quoteId: stored.id,
        quoteHash,
        model: result.model,
        // Recorded for audit. It gates nothing.
        aiConfidence: result.confidence,
        totalPaise: quote.totalPaise.toString(),
        rawInputHash: sha256Hex(parsed.data.rawInput),
      },
      occurredAt: now.toISOString(),
    });

    return reply.status(201).send({
      quoteId: stored.id,
      quoteHash,
      intentId: intent.id,
      state: 'quoted',
      source: 'ai_structured',
      model: result.model,
      confidence: result.confidence,
      totalPaise: quote.totalPaise.toString(),
      structuredQuote: JSON.parse(toCanonicalJson(quote)),
      note: 'Structured only. The drift check still decides whether this may be paid.',
    });
  });

  app.get('/v1/intents/:id', async (request, reply) => {
    const identity = await authenticateAgent(request);
    const { id } = request.params as { id: string };

    const intent = await prisma.paymentIntent.findFirst({
      where: { id, tenantId: identity.tenantId, agentId: identity.agentId },
      include: {
        quotes: { orderBy: { createdAt: 'desc' }, take: 1 },
        driftChecks: { orderBy: { evaluatedAt: 'desc' }, take: 5 },
        merchant: true,
      },
    });
    if (!intent) throw notFound('Intent');

    return reply.send({
      intentId: intent.id,
      state: intent.state,
      mandateId: intent.mandateId,
      merchantId: intent.merchant.externalRef,
      currency: intent.currency,
      authorizedAmountPaise: intent.authorizedAmountPaise?.toString() ?? null,
      capturedAmountPaise: intent.capturedAmountPaise?.toString() ?? null,
      refundedAmountPaise: intent.refundedAmountPaise.toString(),
      blockedReason: intent.blockedReasonJson ? JSON.parse(intent.blockedReasonJson) : null,
      latestQuote: intent.quotes[0]
        ? {
            quoteId: intent.quotes[0].id,
            quoteHash: intent.quotes[0].quoteHash,
            source: intent.quotes[0].source,
            totalPaise: intent.quotes[0].totalPaise.toString(),
          }
        : null,
      driftChecks: intent.driftChecks.map((c) => ({
        decision: c.decision,
        stage: c.stage,
        rulesVersion: c.rulesVersion,
        violations: JSON.parse(c.violationsJson),
        evaluatedAt: c.evaluatedAt.toISOString(),
      })),
    });
  });
}
