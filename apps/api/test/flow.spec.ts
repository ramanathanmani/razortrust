/**
 * End-to-end flow, against a real database and the real server.
 *
 * This is the demo written as a test: a human signs a mandate, a well-behaved
 * agent gets an allow, and a rogue agent gets blocked four different ways. If
 * this file passes, the product claim holds.
 */
import { randomUUID } from 'node:crypto';

import { generateEd25519KeyPair, signCanonical, signingEnvelope } from '@razortrust/core';
import { prisma } from '@razortrust/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hashApiKey } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';

const suffix = randomUUID().slice(0, 8);
const tenantId = `tenant_${suffix}`;
const principalId = `principal_${suffix}`;
const agentId = `agent_${suffix}`;
const merchantRef = `merchant_${suffix}`;
const apiKey = `rzt_agent_${randomUUID().replace(/-/g, '')}`;
const principalKey = `rzt_principal_${randomUUID().replace(/-/g, '')}`;

const principalKeys = generateEd25519KeyPair();
const attackerKeys = generateEd25519KeyPair();

let app: FastifyInstance;
let mandateId: string;

const asPrincipal = { authorization: `Bearer ${principalKey}` };
const asAgent = { authorization: `Bearer ${apiKey}` };
const idem = () => ({ 'idempotency-key': randomUUID() });

/** Good quote: keyboard ₹1,750 + 2 cables ₹500 = ₹2,449 total, in window. */
function goodQuote(overrides: Record<string, unknown> = {}) {
  return {
    quoteVersion: 1,
    merchantId: merchantRef,
    currency: 'INR',
    lineItems: [
      { sku: 'SKU-KEYBOARD-MX', unitPricePaise: '175000', quantity: 1, lineTotalPaise: '175000' },
      { sku: 'SKU-USBC-CABLE-2M', unitPricePaise: '50000', quantity: 2, lineTotalPaise: '100000' },
    ],
    subtotalPaise: '275000',
    taxPaise: '20000',
    shippingPaise: '5000',
    discountPaise: '55100',
    totalPaise: '244900',
    promisedDeliveryAt: '2026-09-01T00:00:00.000Z',
    capturedAt: '2026-08-28T11:55:00.000Z',
    ...overrides,
  };
}

async function newIntent() {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/intents',
    headers: { ...asAgent, ...idem() },
    payload: { mandateId, merchantId: merchantRef },
  });
  expect(res.statusCode).toBe(201);
  return res.json().intentId as string;
}

/** Attach a quote and ask for a verdict. */
async function decide(quote: unknown) {
  const intentId = await newIntent();
  const q = await app.inject({
    method: 'POST',
    url: `/v1/intents/${intentId}/quote`,
    headers: asAgent,
    payload: { structuredQuote: quote, source: 'merchant_api' },
  });
  if (q.statusCode !== 201) return { intentId, stage: 'quote' as const, response: q };

  const c = await app.inject({
    method: 'POST',
    url: `/v1/intents/${intentId}/check`,
    headers: asAgent,
  });
  return { intentId, stage: 'check' as const, response: c };
}

const violationsOf = (res: { json: () => { detail?: { violations?: { ruleId: string }[] } } }) =>
  (res.json().detail?.violations ?? []).map((v) => v.ruleId);

beforeAll(async () => {
  app = await buildServer(loadConfig({ ...process.env, LOG_LEVEL: 'fatal' }));

  await prisma.tenant.create({ data: { id: tenantId, name: `Flow test ${suffix}` } });
  await prisma.principal.create({
    data: {
      id: principalId,
      tenantId,
      name: 'Priya',
      publicKeyPem: principalKeys.publicKeyPem,
      apiKeyHash: hashApiKey(principalKey),
      apiKeyPrefix: principalKey.slice(0, 22),
    },
  });
  await prisma.agent.create({
    data: {
      id: agentId,
      tenantId,
      name: 'Procurement agent',
      apiKeyHash: hashApiKey(apiKey),
      apiKeyPrefix: apiKey.slice(0, 16),
    },
  });
  await prisma.merchant.create({
    data: { id: `m_${suffix}`, tenantId, displayName: 'Office Depot', externalRef: merchantRef },
  });
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('1. the human signs a mandate', () => {
  it('drafts a mandate that cannot yet spend anything', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/mandates',
      headers: asPrincipal,
      payload: {
        agentId,
        currency: 'INR',
        maxAmountPaise: '250000',
        maxCumulativeAmountPaise: '750000',
        maxUses: 3,
        allowedItems: [
          { sku: 'SKU-KEYBOARD-MX', maxUnitPricePaise: '180000', maxQuantity: 1 },
          { sku: 'SKU-USBC-CABLE-2M', maxUnitPricePaise: '60000', maxQuantity: 2 },
        ],
        allowedMerchantIds: [merchantRef],
        deliveryWindow: {
          startsAt: '2026-08-29T00:00:00.000Z',
          endsAt: '2026-09-05T00:00:00.000Z',
        },
        notBefore: '2026-08-28T00:00:00.000Z',
        notAfter: '2026-09-04T00:00:00.000Z',
        captureDeadlineHours: 72,
        autoRefundAllowed: false,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('draft');
    expect(body.termsHash).toMatch(/^[0-9a-f]{64}$/);
    mandateId = body.mandateId;
  });

  it('refuses to let the agent spend against an unsigned draft', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/intents',
      headers: { ...asAgent, ...idem() },
      payload: { mandateId, merchantId: merchantRef },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('MANDATE_REJECTED');
  });

  it('rejects a signature from the wrong key', async () => {
    const draft = await app.inject({
      method: 'GET',
      url: `/v1/mandates/${mandateId}`,
      headers: asPrincipal,
    });
    const { termsHash } = draft.json();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/mandates/${mandateId}/activate`,
      headers: asPrincipal,
      payload: {
        signature: signCanonical(signingEnvelope(termsHash), attackerKeys.privateKeyPem),
        signedByPublicKeyPem: attackerKeys.publicKeyPem,
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('activates on a valid signature from the registered key', async () => {
    const draft = await app.inject({
      method: 'GET',
      url: `/v1/mandates/${mandateId}`,
      headers: asPrincipal,
    });
    const { termsHash } = draft.json();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/mandates/${mandateId}/activate`,
      headers: asPrincipal,
      payload: {
        signature: signCanonical(signingEnvelope(termsHash), principalKeys.privateKeyPem),
        signedByPublicKeyPem: principalKeys.publicKeyPem,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('active');
  });
});

describe('2. the well-behaved agent', () => {
  it('gets an allow on a quote that matches the mandate', async () => {
    const { response } = await decide(goodQuote());
    expect(response.statusCode).toBe(200);
    expect(response.json().decision).toBe('allow');
  });

  it('is told the next step rather than being paid automatically', async () => {
    const { response } = await decide(goodQuote());
    expect(response.json().nextStep).toContain('/authorize');
  });
});

describe('3. the rogue agent', () => {
  it('is blocked for exceeding the price ceiling', async () => {
    const { response } = await decide(
      goodQuote({ discountPaise: '49999', totalPaise: '250001' }),
    );
    expect(response.statusCode).toBe(422);
    expect(violationsOf(response)).toContain('TOTAL_EXCEEDS_MANDATE_CEILING');
  });

  it('is blocked for buying an unapproved SKU', async () => {
    const { response } = await decide(
      goodQuote({
        lineItems: [
          {
            sku: 'SKU-GAMING-CHAIR',
            unitPricePaise: '200000',
            quantity: 1,
            lineTotalPaise: '200000',
          },
        ],
        subtotalPaise: '200000',
        taxPaise: '0',
        shippingPaise: '0',
        discountPaise: '0',
        totalPaise: '200000',
      }),
    );
    expect(response.statusCode).toBe(422);
    expect(violationsOf(response)).toContain('SKU_NOT_ALLOWED');
  });

  it('is blocked for switching merchant', async () => {
    // The merchant must exist in the tenant, but existing is not the same as
    // being on the mandate.
    await prisma.merchant.create({
      data: {
        id: `m2_${suffix}`,
        tenantId,
        displayName: 'Elsewhere',
        externalRef: `other_${suffix}`,
      },
    });
    const intentId = await newIntent();
    await app.inject({
      method: 'POST',
      url: `/v1/intents/${intentId}/quote`,
      headers: asAgent,
      payload: { structuredQuote: goodQuote({ merchantId: `other_${suffix}` }) },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/intents/${intentId}/check`,
      headers: asAgent,
    });
    expect(res.statusCode).toBe(422);
    expect(violationsOf(res)).toContain('MERCHANT_NOT_ALLOWED');
  });

  it('is blocked for splitting quantity across lines to dodge the cap', async () => {
    const { response } = await decide(
      goodQuote({
        lineItems: [
          {
            sku: 'SKU-KEYBOARD-MX',
            unitPricePaise: '100000',
            quantity: 1,
            lineTotalPaise: '100000',
          },
          {
            sku: 'SKU-KEYBOARD-MX',
            unitPricePaise: '100000',
            quantity: 1,
            lineTotalPaise: '100000',
          },
        ],
        subtotalPaise: '200000',
        taxPaise: '0',
        shippingPaise: '0',
        discountPaise: '0',
        totalPaise: '200000',
      }),
    );
    expect(response.statusCode).toBe(422);
    expect(violationsOf(response)).toContain('QUANTITY_EXCEEDED');
  });

  it('is blocked for a delivery date outside the window', async () => {
    const { response } = await decide(
      goodQuote({ promisedDeliveryAt: '2026-09-20T00:00:00.000Z' }),
    );
    expect(response.statusCode).toBe(422);
    expect(violationsOf(response)).toContain('DELIVERY_OUTSIDE_WINDOW');
  });

  it('cannot get a different answer by asking again', async () => {
    const first = await decide(goodQuote({ discountPaise: '49999', totalPaise: '250001' }));
    const retry = await app.inject({
      method: 'POST',
      url: `/v1/intents/${first.intentId}/check`,
      headers: asAgent,
    });
    expect(retry.statusCode).toBe(422);
  });

  it('cannot reach another tenant’s mandate', async () => {
    const otherKey = `rzt_agent_${randomUUID().replace(/-/g, '')}`;
    await prisma.tenant.create({ data: { id: `t2_${suffix}`, name: 'Other tenant' } });
    await prisma.agent.create({
      data: {
        id: `a2_${suffix}`,
        tenantId: `t2_${suffix}`,
        name: 'Outsider',
        apiKeyHash: hashApiKey(otherKey),
        apiKeyPrefix: otherKey.slice(0, 16),
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/intents',
      headers: { authorization: `Bearer ${otherKey}`, ...idem() },
      payload: { mandateId, merchantId: merchantRef },
    });
    expect(res.statusCode).toBe(404);
  });

  it('is refused without a valid API key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/intents',
      headers: { authorization: 'Bearer rzt_agent_not_a_real_key', ...idem() },
      payload: { mandateId, merchantId: merchantRef },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('4. revocation takes effect immediately', () => {
  it('stops the agent mid-flight', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/mandates/${mandateId}/revoke`,
      headers: asPrincipal,
      payload: { reason: 'Changed my mind' },
    });
    expect(res.statusCode).toBe(200);

    const after = await app.inject({
      method: 'POST',
      url: '/v1/intents',
      headers: { ...asAgent, ...idem() },
      payload: { mandateId, merchantId: merchantRef },
    });
    expect(after.statusCode).toBe(403);
    expect(after.json().detail.failures.map((f: { code: string }) => f.code)).toContain('REVOKED');
  });
});

describe('5. idempotency', () => {
  it('replays the original response rather than creating a second intent', async () => {
    // Fresh mandate, since the one above is revoked.
    const draft = await app.inject({
      method: 'POST',
      url: '/v1/mandates',
      headers: asPrincipal,
      payload: {
        agentId,
        currency: 'INR',
        maxAmountPaise: '250000',
        maxCumulativeAmountPaise: '750000',
        maxUses: 3,
        allowedItems: [{ sku: 'SKU-KEYBOARD-MX', maxUnitPricePaise: '180000', maxQuantity: 1 }],
        allowedMerchantIds: [merchantRef],
        deliveryWindow: {
          startsAt: '2026-08-29T00:00:00.000Z',
          endsAt: '2026-09-05T00:00:00.000Z',
        },
        notBefore: '2026-08-28T00:00:00.000Z',
        notAfter: '2026-09-04T00:00:00.000Z',
        captureDeadlineHours: 72,
        autoRefundAllowed: false,
      },
    });
    const fresh = draft.json();
    await app.inject({
      method: 'POST',
      url: `/v1/mandates/${fresh.mandateId}/activate`,
      headers: asPrincipal,
      payload: {
        signature: signCanonical(
          signingEnvelope(fresh.termsHash),
          principalKeys.privateKeyPem,
        ),
        signedByPublicKeyPem: principalKeys.publicKeyPem,
      },
    });

    const key = { 'idempotency-key': randomUUID() };
    const payload = { mandateId: fresh.mandateId, merchantId: merchantRef };

    const a = await app.inject({
      method: 'POST',
      url: '/v1/intents',
      headers: { ...asAgent, ...key },
      payload,
    });
    const b = await app.inject({
      method: 'POST',
      url: '/v1/intents',
      headers: { ...asAgent, ...key },
      payload,
    });

    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.json().intentId).toBe(a.json().intentId);
  });

  it('rejects the same key with a different body', async () => {
    const key = { 'idempotency-key': randomUUID() };
    await app.inject({
      method: 'POST',
      url: '/v1/intents',
      headers: { ...asAgent, ...key },
      payload: { mandateId, merchantId: merchantRef },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/intents',
      headers: { ...asAgent, ...key },
      payload: { mandateId, merchantId: merchantRef, requestedAmountPaise: '1' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('requires an idempotency key at all', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/intents',
      headers: asAgent,
      payload: { mandateId, merchantId: merchantRef },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('6. the audit trail', () => {
  it('recorded every step, in a verifiable chain', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/audit', headers: asPrincipal });
    expect(res.statusCode).toBe(200);

    const { events } = res.json();
    const types = events.map((e: { eventType: string }) => e.eventType);

    expect(types).toEqual(
      expect.arrayContaining([
        'mandate.drafted',
        'mandate.activated',
        'mandate.revoked',
        'intent.created',
        'quote.submitted',
        'drift.evaluated',
        'drift.blocked',
      ]),
    );

    // Every entry links to the one before it.
    for (let i = 1; i < events.length; i += 1) {
      expect(events[i].prevHash).toBe(events[i - 1].hash);
    }
  });

  it('reports the chain as intact', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/audit/verify',
      headers: asPrincipal,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it('records the block with the rule that caused it', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/audit', headers: asPrincipal });
    const blocked = res
      .json()
      .events.filter((e: { eventType: string }) => e.eventType === 'drift.blocked');

    expect(blocked.length).toBeGreaterThan(0);
    const allRules = blocked.flatMap((e: { payload: { violations: string[] } }) => e.payload.violations);
    expect(allRules).toEqual(
      expect.arrayContaining(['TOTAL_EXCEEDS_MANDATE_CEILING', 'SKU_NOT_ALLOWED']),
    );
  });
});
