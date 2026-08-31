/**
 * Post-delivery settlement, end to end.
 *
 * The thing being proved here is the separation: the engine recommends, and a
 * human (or an explicitly permissive mandate) executes. An agent must not be
 * able to talk itself into a refund.
 */
import { randomUUID } from 'node:crypto';

import type { FakeGateway } from '@razortrust/adapters';
import { generateEd25519KeyPair, signCanonical, signingEnvelope } from '@razortrust/core';
import { prisma } from '@razortrust/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hashApiKey } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { asFakeGateway, getGateway, resetGateway } from '../src/gateway.js';
import { buildServer } from '../src/server.js';

const suffix = randomUUID().slice(0, 8);
const tenantId = `t_set_${suffix}`;
const principalId = `p_set_${suffix}`;
const agentId = `a_set_${suffix}`;
const merchantRef = `m_set_${suffix}`;
const apiKey = `rzt_agent_${randomUUID().replace(/-/g, '')}`;
const principalKey = `rzt_principal_${randomUUID().replace(/-/g, '')}`;
const keys = generateEd25519KeyPair();

let app: FastifyInstance;
let fake: FakeGateway;

/**
 * Dates are relative to the real clock, not hard-coded.
 *
 * The engine escalates a delivery timestamp in the future — correctly — so a
 * fixture pinned to a calendar date would start failing the moment the wall
 * clock moved past it.
 */
const DAY = 86_400_000;
const now = Date.now();
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();

const WINDOW_START = iso(-2 * DAY);
const WINDOW_END = iso(5 * DAY);
const NOT_BEFORE = iso(-3 * DAY);
const NOT_AFTER = iso(4 * DAY);
const SHIPPED_AT = iso(-1 * DAY);
const DELIVERED_AT = iso(-3_600_000);

const asPrincipal = { authorization: `Bearer ${principalKey}` };
const asAgent = { authorization: `Bearer ${apiKey}` };
const idem = () => ({ 'idempotency-key': randomUUID() });

function quote(promisedDeliveryAt: string = DELIVERED_AT) {
  return {
    quoteVersion: 1,
    merchantId: merchantRef,
    currency: 'INR',
    lineItems: [
      { sku: 'SKU-KEYBOARD-MX', unitPricePaise: '175000', quantity: 1, lineTotalPaise: '175000' },
      { sku: 'SKU-USBC-CABLE-2M', unitPricePaise: '50000', quantity: 2, lineTotalPaise: '100000' },
    ],
    subtotalPaise: '275000',
    taxPaise: '0',
    shippingPaise: '0',
    discountPaise: '75000',
    totalPaise: '200000',
    promisedDeliveryAt,
    capturedAt: iso(-7_200_000),
  };
}

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    evidenceVersion: 1,
    status: 'delivered',
    trackingId: 'TRK-1234',
    carrier: 'Bluedart',
    shippedAt: SHIPPED_AT,
    deliveredAt: DELIVERED_AT,
    lineItems: [
      { sku: 'SKU-KEYBOARD-MX', quantity: 1, condition: 'good' },
      { sku: 'SKU-USBC-CABLE-2M', quantity: 2, condition: 'good' },
    ],
    ...overrides,
  };
}

async function newMandate(
  autoRefundAllowed = false,
  window: { startsAt: string; endsAt: string } = { startsAt: WINDOW_START, endsAt: WINDOW_END },
) {
  const draft = await app.inject({
    method: 'POST',
    url: '/v1/mandates',
    headers: asPrincipal,
    payload: {
      agentId,
      currency: 'INR',
      maxAmountPaise: '250000',
      maxCumulativeAmountPaise: '2000000',
      maxUses: 20,
      allowedItems: [
        { sku: 'SKU-KEYBOARD-MX', maxUnitPricePaise: '180000', maxQuantity: 1 },
        { sku: 'SKU-USBC-CABLE-2M', maxUnitPricePaise: '60000', maxQuantity: 2 },
      ],
      allowedMerchantIds: [merchantRef],
      deliveryWindow: window,
      notBefore: NOT_BEFORE,
      notAfter: NOT_AFTER,
      captureDeadlineHours: 72,
      autoRefundAllowed,
    },
  });
  const body = draft.json();
  await app.inject({
    method: 'POST',
    url: `/v1/mandates/${body.mandateId}/activate`,
    headers: asPrincipal,
    payload: {
      signature: signCanonical(signingEnvelope(body.termsHash), keys.privateKeyPem),
      signedByPublicKeyPem: keys.publicKeyPem,
    },
  });
  return body.mandateId as string;
}

/** Drive an intent all the way to a captured payment of ₹2,000. */
async function capturedIntent(
  autoRefundAllowed = false,
  window?: { startsAt: string; endsAt: string },
  promisedDeliveryAt: string = DELIVERED_AT,
) {
  const mandateId = await newMandate(autoRefundAllowed, window);

  const intent = await app.inject({
    method: 'POST',
    url: '/v1/intents',
    headers: { ...asAgent, ...idem() },
    payload: { mandateId, merchantId: merchantRef },
  });
  const intentId = intent.json().intentId as string;

  await app.inject({
    method: 'POST',
    url: `/v1/intents/${intentId}/quote`,
    headers: asAgent,
    payload: { structuredQuote: quote(promisedDeliveryAt) },
  });

  const auth = await app.inject({
    method: 'POST',
    url: `/v1/intents/${intentId}/authorize`,
    headers: { ...asAgent, ...idem() },
  });

  const payment = fake.simulateCustomerAuthorization(auth.json().orderId);
  const hook = fake.buildWebhook('payment.authorized', { payment });
  await app.inject({
    method: 'POST',
    url: '/v1/webhooks/razorpay',
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': hook.signature,
      'x-razorpay-event-id': hook.eventId,
    },
    payload: hook.body,
  });

  await app.inject({
    method: 'POST',
    url: `/v1/intents/${intentId}/capture`,
    headers: { ...asAgent, ...idem() },
  });

  return { intentId, mandateId };
}

async function settle(intentId: string, ev: Record<string, unknown>) {
  await app.inject({
    method: 'POST',
    url: `/v1/intents/${intentId}/delivery`,
    headers: asAgent,
    payload: { evidence: ev },
  });
  return app.inject({
    method: 'POST',
    url: `/v1/intents/${intentId}/settle`,
    headers: asAgent,
  });
}

beforeAll(async () => {
  resetGateway();
  const config = loadConfig({
    ...process.env,
    LOG_LEVEL: 'fatal',
    RAZORPAY_KEY_ID: '',
    RAZORPAY_KEY_SECRET: '',
    RAZORPAY_WEBHOOK_SECRET: 'test_webhook_secret',
  });
  app = await buildServer(config);
  fake = asFakeGateway(getGateway(config));

  await prisma.tenant.create({ data: { id: tenantId, name: `Settlement ${suffix}` } });
  await prisma.principal.create({
    data: {
      id: principalId,
      tenantId,
      name: 'Priya',
      publicKeyPem: keys.publicKeyPem,
      apiKeyHash: hashApiKey(principalKey),
      apiKeyPrefix: principalKey.slice(0, 22),
    },
  });
  await prisma.agent.create({
    data: {
      id: agentId,
      tenantId,
      name: 'Agent',
      apiKeyHash: hashApiKey(apiKey),
      apiKeyPrefix: apiKey.slice(0, 16),
    },
  });
  await prisma.merchant.create({
    data: { id: `ms_${suffix}`, tenantId, displayName: 'Depot', externalRef: merchantRef },
  });
});

afterAll(async () => {
  await app.close();
  resetGateway();
  await prisma.$disconnect();
});

describe('a clean delivery', () => {
  it('recommends nothing', async () => {
    const { intentId } = await capturedIntent();
    const res = await settle(intentId, evidence());

    expect(res.statusCode).toBe(200);
    expect(res.json().recommendation).toBe('none');
    expect(res.json().refundAmountPaise).toBe('0');
  });

  it('refuses to execute a "none" recommendation', async () => {
    const { intentId } = await capturedIntent();
    const settled = await settle(intentId, evidence());

    const res = await app.inject({
      method: 'POST',
      url: `/v1/settlements/${settled.json().settlementId}/execute`,
      headers: { ...asPrincipal, ...idem() },
      payload: { confirmRefundAmountPaise: '0' },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('a failed delivery', () => {
  it('recommends a full refund and a human executes it', async () => {
    const { intentId } = await capturedIntent();
    const settled = await settle(intentId, evidence({ status: 'failed', deliveredAt: undefined }));

    expect(settled.json().recommendation).toBe('full_refund');
    expect(settled.json().refundAmountPaise).toBe('200000');
    expect(settled.json().autoExecutable).toBe(false);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/settlements/${settled.json().settlementId}/execute`,
      headers: { ...asPrincipal, ...idem() },
      payload: { confirmRefundAmountPaise: '200000', reason: 'never arrived' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().kind).toBe('full');
    expect(res.json().state).toBe('refunded');

    const intent = await prisma.paymentIntent.findUnique({ where: { id: intentId } });
    expect(intent?.refundedAmountPaise).toBe(200000n);
  });
});

describe('a short delivery', () => {
  it('recommends a partial refund for the missing cables', async () => {
    const { intentId } = await capturedIntent();
    const settled = await settle(
      intentId,
      evidence({ lineItems: [{ sku: 'SKU-KEYBOARD-MX', quantity: 1, condition: 'good' }] }),
    );

    expect(settled.json().recommendation).toBe('partial_refund');
    expect(settled.json().refundAmountPaise).toBe('100000');

    const res = await app.inject({
      method: 'POST',
      url: `/v1/settlements/${settled.json().settlementId}/execute`,
      headers: { ...asPrincipal, ...idem() },
      payload: { confirmRefundAmountPaise: '100000' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().kind).toBe('partial');
    expect(res.json().state).toBe('partially_refunded');
  });
});

describe('escalation', () => {
  it('escalates a late delivery and refuses to execute it', async () => {
    // A window that already closed, with the goods promised inside it and
    // actually delivered after it. Both timestamps stay in the past, so the
    // rule that fires is lateness rather than a future timestamp.
    const closedWindow = { startsAt: iso(-4 * DAY), endsAt: iso(-2 * DAY) };
    const { intentId } = await capturedIntent(false, closedWindow, iso(-3 * DAY));

    const settled = await settle(intentId, evidence({ deliveredAt: DELIVERED_AT }));

    expect(settled.json().recommendation).toBe('escalate');
    expect(settled.json().refundAmountPaise).toBe('0');
    expect(settled.json().note).toContain('human judgement');

    const res = await app.inject({
      method: 'POST',
      url: `/v1/settlements/${settled.json().settlementId}/execute`,
      headers: { ...asPrincipal, ...idem() },
      payload: { confirmRefundAmountPaise: '0' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('escalates a delivery with no tracking evidence', async () => {
    const { intentId } = await capturedIntent();
    const settled = await settle(intentId, evidence({ trackingId: undefined, carrier: undefined }));
    expect(settled.json().recommendation).toBe('escalate');
  });
});

describe('who is allowed to move money back', () => {
  it('does not let an agent execute a refund on an ordinary mandate', async () => {
    const { intentId } = await capturedIntent(false);
    const settled = await settle(intentId, evidence({ status: 'failed', deliveredAt: undefined }));

    const res = await app.inject({
      method: 'POST',
      url: `/v1/settlements/${settled.json().settlementId}/execute`,
      headers: { ...asAgent, ...idem() },
      payload: { confirmRefundAmountPaise: '200000' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain('human');
  });

  it('lets an agent execute only when the signed mandate said so', async () => {
    const { intentId } = await capturedIntent(true);
    const settled = await settle(intentId, evidence({ status: 'failed', deliveredAt: undefined }));

    expect(settled.json().autoExecutable).toBe(true);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/settlements/${settled.json().settlementId}/execute`,
      headers: { ...asAgent, ...idem() },
      payload: { confirmRefundAmountPaise: '200000' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects an execution that confirms a stale amount', async () => {
    const { intentId } = await capturedIntent();
    const settled = await settle(intentId, evidence({ status: 'failed', deliveredAt: undefined }));

    const res = await app.inject({
      method: 'POST',
      url: `/v1/settlements/${settled.json().settlementId}/execute`,
      headers: { ...asPrincipal, ...idem() },
      payload: { confirmRefundAmountPaise: '999999' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain('does not match');
  });

  it('will not execute the same settlement twice', async () => {
    const { intentId } = await capturedIntent();
    const settled = await settle(intentId, evidence({ status: 'failed', deliveredAt: undefined }));
    const id = settled.json().settlementId;

    const first = await app.inject({
      method: 'POST',
      url: `/v1/settlements/${id}/execute`,
      headers: { ...asPrincipal, ...idem() },
      payload: { confirmRefundAmountPaise: '200000' },
    });
    const second = await app.inject({
      method: 'POST',
      url: `/v1/settlements/${id}/execute`,
      headers: { ...asPrincipal, ...idem() },
      payload: { confirmRefundAmountPaise: '200000' },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(409);
  });
});

describe('uncaptured payments', () => {
  it('recommends nothing, because a hold is released rather than refunded', async () => {
    const mandateId = await newMandate();
    const intent = await app.inject({
      method: 'POST',
      url: '/v1/intents',
      headers: { ...asAgent, ...idem() },
      payload: { mandateId, merchantId: merchantRef },
    });
    const intentId = intent.json().intentId as string;
    await app.inject({
      method: 'POST',
      url: `/v1/intents/${intentId}/quote`,
      headers: asAgent,
      payload: { structuredQuote: quote() },
    });

    const settled = await settle(intentId, evidence({ status: 'failed', deliveredAt: undefined }));
    expect(settled.json().recommendation).toBe('none');
    expect(settled.json().reasons[0].ruleId).toBe('NOT_CAPTURED');
  });
});

describe('evidence handling', () => {
  it('rejects malformed evidence at the door', async () => {
    const { intentId } = await capturedIntent();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/intents/${intentId}/delivery`,
      headers: asAgent,
      payload: { evidence: { nonsense: true } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('keeps every evaluation rather than overwriting the last', async () => {
    const { intentId } = await capturedIntent();
    await settle(intentId, evidence());
    await settle(intentId, evidence({ status: 'failed', deliveredAt: undefined }));

    const res = await app.inject({
      method: 'GET',
      url: `/v1/intents/${intentId}/settlements`,
      headers: asPrincipal,
    });
    const settlements = res.json().settlements;
    expect(settlements.length).toBe(2);
    expect(settlements.map((s: { recommendation: string }) => s.recommendation)).toEqual(
      expect.arrayContaining(['none', 'full_refund']),
    );
  });
});

describe('the audit trail', () => {
  it('records evaluation and execution as separate facts', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/audit', headers: asPrincipal });
    const types = res.json().events.map((e: { eventType: string }) => e.eventType);

    expect(types).toEqual(
      expect.arrayContaining([
        'delivery.recorded',
        'settlement.evaluated',
        'refund.requested',
        'refund.succeeded',
      ]),
    );
  });

  it('still verifies', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/audit/verify',
      headers: asPrincipal,
    });
    expect(res.json().ok).toBe(true);
  });
});
