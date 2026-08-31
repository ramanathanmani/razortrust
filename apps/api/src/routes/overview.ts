/**
 * The console's read model.
 *
 * One authenticated read that returns exactly what the four dashboard panels
 * need. It exists because the console would otherwise have to guess ids: there
 * is no "list my mandates" endpoint, and adding four round trips to build one
 * screen is worse than adding one endpoint that answers the screen's question.
 *
 * Strictly read-only, and strictly a *reporter*. It never re-evaluates
 * anything. The drift verdict it returns is the one the engine already wrote to
 * `drift_checks`; the per-field match flags are derived from the violation ids
 * on that stored verdict, not from a second opinion computed here. If this file
 * ever starts deciding, the "plain code decides, in one place" claim stops
 * being true.
 */
import { mandateTermsSchema, type MandateTerms } from '@razortrust/core';
import { prisma, verifyAuditIntegrity } from '@razortrust/db';
import type { FastifyInstance } from 'fastify';

import { authenticatePrincipal } from '../auth.js';
import type { Config } from '../config.js';
import { notFound } from '../errors.js';

/**
 * Which constraint each drift rule speaks to.
 *
 * Used only to colour the comparison table. A rule missing from this map still
 * blocks the payment — it simply has no row of its own to light up, and the
 * unmapped ids are returned in `otherViolations` so nothing is hidden.
 */
const RULE_TO_FIELD: Record<string, 'price' | 'sku' | 'merchant' | 'delivery'> = {
  TOTAL_EXCEEDS_MANDATE_CEILING: 'price',
  UNIT_PRICE_EXCEEDED: 'price',
  CUMULATIVE_CEILING_EXCEEDED: 'price',
  ZERO_TOTAL: 'price',
  LINE_TOTAL_ARITHMETIC: 'price',
  SUBTOTAL_ARITHMETIC: 'price',
  TOTAL_ARITHMETIC: 'price',
  SKU_NOT_ALLOWED: 'sku',
  QUANTITY_EXCEEDED: 'sku',
  MERCHANT_NOT_ALLOWED: 'merchant',
  DELIVERY_OUTSIDE_WINDOW: 'delivery',
  DELIVERY_AFTER_MANDATE_EXPIRY: 'delivery',
  QUOTE_EXPIRED: 'delivery',
};

/** Money leaves this API as a decimal string of paise, never a JS number. */
const paise = (v: bigint | number | string | null | undefined) =>
  v === null || v === undefined ? null : v.toString();

interface StoredQuote {
  currency: string;
  totalPaise: string | bigint;
  merchantId: string;
  promisedDeliveryAt: string;
  lineItems: { sku: string; unitPricePaise: string | bigint; quantity: number }[];
}

function comparisonRows(
  terms: MandateTerms,
  quote: StoredQuote | null,
  violatedFields: Set<string>,
) {
  const skus = terms.allowedItems.map((i) => i.sku);
  return [
    {
      field: 'Price',
      mandate: `≤ ${paise(terms.maxAmountPaise)}`,
      quote: quote ? paise(quote.totalPaise) : null,
      match: !violatedFields.has('price'),
    },
    {
      field: 'SKU',
      mandate: skus.join(', '),
      quote: quote ? [...new Set(quote.lineItems.map((l) => l.sku))].join(', ') : null,
      match: !violatedFields.has('sku'),
    },
    {
      field: 'Merchant',
      mandate: terms.allowedMerchantIds.join(', '),
      quote: quote?.merchantId ?? null,
      match: !violatedFields.has('merchant'),
    },
    {
      field: 'Delivery',
      mandate: `${terms.deliveryWindow.startsAt} – ${terms.deliveryWindow.endsAt}`,
      quote: quote?.promisedDeliveryAt ?? null,
      match: !violatedFields.has('delivery'),
    },
  ];
}

export async function overviewRoutes(app: FastifyInstance, _config: Config) {
  /**
   * Everything the console renders, for one principal.
   *
   * `mandateId` selects a specific mandate; without it, the most recently
   * created one belonging to the caller is used.
   */
  app.get('/v1/console/overview', async (request, reply) => {
    const identity = await authenticatePrincipal(request);
    const query = request.query as { mandateId?: string };

    const mandateRow = await prisma.mandate.findFirst({
      where: {
        tenantId: identity.tenantId,
        // Scoped to the caller, not the tenant: seeing a colleague's mandate is
        // not the same as owning it, and the console is a personal view.
        principalId: identity.principalId,
        ...(query.mandateId ? { id: query.mandateId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: { principal: { select: { name: true, email: true } } },
    });

    if (!mandateRow) {
      // An empty console is a legitimate state, not an error — a new principal
      // simply has not signed anything yet. The UI renders an empty state.
      return reply.send({
        mandate: null,
        drift: null,
        settlement: null,
        audit: { events: [], blockedCount: 0 },
        chain: await verifyAuditIntegrity({ tenantId: identity.tenantId }),
      });
    }

    const terms = mandateTermsSchema.parse(JSON.parse(mandateRow.termsJson));

    /**
     * The most recent intent that actually reached a verdict.
     *
     * Not simply the newest: an intent can be created and then abandoned before
     * a quote is attached, and a console whose main panel goes blank because
     * someone started a request they never finished is reporting the wrong
     * thing. Falls back to the newest intent when none has been evaluated yet,
     * so a fresh mandate still shows its (empty) state honestly.
     */
    const include = {
      merchant: true,
      authorization: true,
      quotes: { orderBy: { createdAt: 'desc' }, take: 1 },
      driftChecks: { orderBy: { evaluatedAt: 'desc' }, take: 1 },
      settlements: { orderBy: { evaluatedAt: 'desc' }, take: 1 },
    } as const;

    /**
     * Prefer the intent that got furthest through the lifecycle.
     *
     * All four panels describe ONE intent, so they have to agree. Picking the
     * newest would routinely show a blocked attempt with an empty settlement
     * panel — technically consistent, but it hides the outcome a human opened
     * the console to see. Settled beats evaluated beats merely created.
     */
    const intent =
      (await prisma.paymentIntent.findFirst({
        where: { mandateId: mandateRow.id, settlements: { some: {} } },
        orderBy: { createdAt: 'desc' },
        include,
      })) ??
      (await prisma.paymentIntent.findFirst({
        where: { mandateId: mandateRow.id, driftChecks: { some: {} } },
        orderBy: { createdAt: 'desc' },
        include,
      })) ??
      (await prisma.paymentIntent.findFirst({
        where: { mandateId: mandateRow.id },
        orderBy: { createdAt: 'desc' },
        include,
      }));

    const quoteRow = intent?.quotes[0] ?? null;
    const driftRow = intent?.driftChecks[0] ?? null;
    const settlementRow = intent?.settlements[0] ?? null;

    const quote: StoredQuote | null = quoteRow ? JSON.parse(quoteRow.structuredJson) : null;

    const violations: { ruleId: string; message: string }[] = driftRow
      ? JSON.parse(driftRow.violationsJson)
      : [];
    const violatedFields = new Set(
      violations.map((v) => RULE_TO_FIELD[v.ruleId]).filter(Boolean) as string[],
    );

    const events = await prisma.auditEvent.findMany({
      where: { tenantId: identity.tenantId },
      orderBy: { seq: 'desc' },
      take: 40,
    });

    const chain = await verifyAuditIntegrity({ tenantId: identity.tenantId });

    return reply.send({
      mandate: {
        id: mandateRow.id,
        status: mandateRow.status,
        currency: terms.currency,
        maxAmountPaise: paise(terms.maxAmountPaise),
        allowedSkus: terms.allowedItems.map((i) => i.sku),
        allowedMerchants: terms.allowedMerchantIds,
        deliveryWindow: terms.deliveryWindow,
        signedBy: mandateRow.principal.email ?? mandateRow.principal.name,
        signedAt: mandateRow.signedAt?.toISOString() ?? null,
        signatureAlgorithm: 'Ed25519',
        // A mandate is "signed" only if a signature is actually on file. The
        // console must never show a green tick for a draft.
        signatureValid: Boolean(mandateRow.signature),
        termsHash: mandateRow.termsHash,
        usesCount: mandateRow.usesCount,
        maxUses: terms.maxUses,
        revokedAt: mandateRow.revokedAt?.toISOString() ?? null,
      },

      drift: driftRow
        ? {
            decision: driftRow.decision as 'allow' | 'block',
            stage: driftRow.stage,
            rulesVersion: driftRow.rulesVersion,
            evaluatedAt: driftRow.evaluatedAt.toISOString(),
            quoteId: quoteRow?.id ?? null,
            quoteHash: quoteRow?.quoteHash ?? null,
            quoteSource: quoteRow?.source ?? null,
            violations,
            comparison: comparisonRows(terms, quote, violatedFields),
            otherViolations: violations
              .filter((v) => !RULE_TO_FIELD[v.ruleId])
              .map((v) => v.ruleId),
          }
        : null,

      settlement: settlementRow
        ? {
            id: settlementRow.id,
            recommendation: settlementRow.recommendation,
            refundAmountPaise: paise(settlementRow.refundAmountPaise),
            reasons: JSON.parse(settlementRow.reasonsJson),
            rulesVersion: settlementRow.rulesVersion,
            evaluatedAt: settlementRow.evaluatedAt.toISOString(),
            executedAt: settlementRow.executedAt?.toISOString() ?? null,
            // Only the signed mandate can grant this. Reported, never inferred.
            autoRefundAllowed: terms.autoRefundAllowed,
          }
        : null,

      intent: intent
        ? {
            id: intent.id,
            state: intent.state,
            merchantName: intent.merchant.displayName,
            currency: intent.currency,
            authorizedAmountPaise: paise(intent.authorizedAmountPaise),
            capturedAmountPaise: paise(intent.capturedAmountPaise),
            refundedAmountPaise: paise(intent.refundedAmountPaise),
            rzpOrderId: intent.authorization?.rzpOrderId ?? null,
            rzpPaymentId: intent.authorization?.rzpPaymentId ?? null,
            captureMode: intent.authorization?.captureMode ?? null,
            captureDeadline: intent.authorization?.captureDeadline?.toISOString() ?? null,
          }
        : null,

      audit: {
        blockedCount: events.filter(
          (e) => e.eventType === 'drift.blocked' || e.eventType === 'quote.ai_rejected',
        ).length,
        events: events.map((e) => ({
          seq: e.seq,
          eventType: e.eventType,
          actorType: e.actorType,
          actorId: e.actorId,
          payload: JSON.parse(e.payloadJson),
          hash: e.hash,
          occurredAt: e.occurredAt.toISOString(),
        })),
      },

      chain,
    });
  });

  /** Which mandates this principal can look at, for the console's switcher. */
  app.get('/v1/console/mandates', async (request, reply) => {
    const identity = await authenticatePrincipal(request);

    const rows = await prisma.mandate.findMany({
      where: { tenantId: identity.tenantId, principalId: identity.principalId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        status: true,
        currency: true,
        maxAmountPaise: true,
        createdAt: true,
        signedAt: true,
      },
    });
    if (rows.length === 0) throw notFound('Mandates');

    return reply.send({
      mandates: rows.map((m) => ({
        id: m.id,
        status: m.status,
        currency: m.currency,
        maxAmountPaise: paise(m.maxAmountPaise),
        createdAt: m.createdAt.toISOString(),
        signedAt: m.signedAt?.toISOString() ?? null,
      })),
    });
  });
}
