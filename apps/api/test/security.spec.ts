/**
 * Security regressions.
 *
 * Each block here corresponds to a way the system was, or could be, talked out
 * of the guarantee it makes. They are written as attacks rather than features,
 * because that is how they will be attempted.
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
const tenantId = `t_sec_${suffix}`;
const merchantRef = `m_sec_${suffix}`;

// Two humans in the SAME tenant. Most of this file is about the difference
// between "same organisation" and "same person".
const owner = {
  id: `owner_${suffix}`,
  token: `rzt_principal_${randomUUID().replace(/-/g, '')}`,
  keys: generateEd25519KeyPair(),
};
const colleague = {
  id: `colleague_${suffix}`,
  token: `rzt_principal_${randomUUID().replace(/-/g, '')}`,
  keys: generateEd25519KeyPair(),
};

const agentId = `a_sec_${suffix}`;
const agentKey = `rzt_agent_${randomUUID().replace(/-/g, '')}`;

let app: FastifyInstance;
let fake: FakeGateway;
let config: ReturnType<typeof loadConfig>;

const asOwner = { authorization: `Bearer ${owner.token}` };
const asColleague = { authorization: `Bearer ${colleague.token}` };
const asAgent = { authorization: `Bearer ${agentKey}` };
const idem = () => ({ 'idempotency-key': randomUUID() });

const DAY = 86_400_000;
const now = Date.now();
const iso = (o: number) => new Date(now + o).toISOString();
const DELIVERY = iso(2 * DAY);

function quote(o: Record<string, unknown> = {}) {
  return {
    quoteVersion: 1,
    merchantId: merchantRef,
    currency: 'INR',
    lineItems: [
      { sku: 'SKU-KEYBOARD-MX', unitPricePaise: '175000', quantity: 1, lineTotalPaise: '175000' },
    ],
    subtotalPaise: '175000',
    taxPaise: '0',
    shippingPaise: '0',
    discountPaise: '0',
    totalPaise: '175000',
    promisedDeliveryAt: DELIVERY,
    capturedAt: iso(0),
    ...o,
  };
}

/** Draft + sign + activate a mandate owned by `who`. */
async function newMandate(who: typeof owner, autoRefundAllowed = false) {
  const headers = { authorization: `Bearer ${who.token}` };
  const draft = await app.inject({
    method: 'POST',
    url: '/v1/mandates',
    headers,
    payload: {
      agentId,
      currency: 'INR',
      maxAmountPaise: '250000',
      maxCumulativeAmountPaise: '2000000',
      maxUses: 20,
      allowedItems: [{ sku: 'SKU-KEYBOARD-MX', maxUnitPricePaise: '180000', maxQuantity: 1 }],
      allowedMerchantIds: [merchantRef],
      deliveryWindow: { startsAt: iso(-DAY), endsAt: iso(5 * DAY) },
      notBefore: iso(-2 * DAY),
      notAfter: iso(4 * DAY),
      captureDeadlineHours: 72,
      autoRefundAllowed,
    },
  });
  const body = draft.json();
  await app.inject({
    method: 'POST',
    url: `/v1/mandates/${body.mandateId}/activate`,
    headers,
    payload: {
      signature: signCanonical(signingEnvelope(body.termsHash), who.keys.privateKeyPem),
      signedByPublicKeyPem: who.keys.publicKeyPem,
    },
  });
  return body.mandateId as string;
}

/** Intent + quote + authorize, returning the approval link. */
async function authorizedIntent(mandateId: string, q: unknown = quote()) {
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
    payload: { structuredQuote: q },
  });

  const auth = await app.inject({
    method: 'POST',
    url: `/v1/intents/${intentId}/authorize`,
    headers: { ...asAgent, ...idem() },
  });

  return { intentId, auth, approvalUrl: auth.json().approvalUrl as string };
}

beforeAll(async () => {
  resetGateway();
  config = loadConfig({
    ...process.env,
    LOG_LEVEL: 'fatal',
    RAZORPAY_KEY_ID: '',
    RAZORPAY_KEY_SECRET: '',
    RAZORPAY_WEBHOOK_SECRET: 'test_webhook_secret',
    ANTHROPIC_API_KEY: '',
  });
  app = await buildServer(config);
  fake = asFakeGateway(getGateway(config));

  await prisma.tenant.create({ data: { id: tenantId, name: `Security ${suffix}` } });
  for (const p of [owner, colleague]) {
    await prisma.principal.create({
      data: {
        id: p.id,
        tenantId,
        name: p.id,
        publicKeyPem: p.keys.publicKeyPem,
        apiKeyHash: hashApiKey(p.token),
        apiKeyPrefix: p.token.slice(0, 22),
      },
    });
  }
  await prisma.agent.create({
    data: {
      id: agentId,
      tenantId,
      name: 'Agent',
      apiKeyHash: hashApiKey(agentKey),
      apiKeyPrefix: agentKey.slice(0, 16),
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

// --------------------------------------------------------------------------

describe('auth spoofing', () => {
  it('refuses the old x-principal-id header entirely', async () => {
    // The header used to BE the authentication. Naming a principal must now
    // achieve nothing at all.
    const res = await app.inject({
      method: 'GET',
      url: '/v1/audit',
      headers: { 'x-principal-id': owner.id },
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a request that names a real principal id as a bearer token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/audit',
      headers: { authorization: `Bearer ${owner.id}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a well-formed but unissued token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/audit',
      headers: { authorization: `Bearer rzt_principal_${randomUUID().replace(/-/g, '')}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a missing or malformed Authorization header', async () => {
    for (const headers of [{}, { authorization: 'Bearer' }, { authorization: owner.token }]) {
      const res = await app.inject({ method: 'GET', url: '/v1/audit', headers });
      expect(res.statusCode).toBe(401);
    }
  });

  it('does not let an agent token act as a human', async () => {
    // Agents and humans have different powers. An agent key must not open a
    // human-only endpoint even though both are bearer tokens.
    const res = await app.inject({ method: 'GET', url: '/v1/audit', headers: asAgent });
    expect(res.statusCode).toBe(401);
  });

  it('does not let a human token act as an agent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/intents',
      headers: { ...asOwner, ...idem() },
      payload: { mandateId: randomUUID(), merchantId: merchantRef },
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a suspended principal', async () => {
    const token = `rzt_principal_${randomUUID().replace(/-/g, '')}`;
    await prisma.principal.create({
      data: {
        id: `suspended_${suffix}`,
        tenantId,
        name: 'Suspended',
        publicKeyPem: generateEd25519KeyPair().publicKeyPem,
        apiKeyHash: hashApiKey(token),
        apiKeyPrefix: token.slice(0, 22),
        status: 'suspended',
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/audit',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('never stores the token itself', async () => {
    const row = await prisma.principal.findUnique({ where: { id: owner.id } });
    expect(row?.apiKeyHash).toBe(hashApiKey(owner.token));
    expect(row?.apiKeyHash).not.toContain(owner.token);
    expect(JSON.stringify(row)).not.toContain(owner.token.slice(22));
  });
});

// --------------------------------------------------------------------------

describe('cross-user actions inside one tenant', () => {
  it('does not let a colleague revoke someone else’s mandate', async () => {
    const mandateId = await newMandate(owner);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/mandates/${mandateId}/revoke`,
      headers: asColleague,
      payload: { reason: 'not mine to cancel' },
    });

    expect(res.statusCode).toBe(403);
    const row = await prisma.mandate.findUnique({ where: { id: mandateId } });
    expect(row?.status).toBe('active');
  });

  it('lets the owner revoke their own mandate', async () => {
    const mandateId = await newMandate(owner);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/mandates/${mandateId}/revoke`,
      headers: asOwner,
    });
    expect(res.statusCode).toBe(200);
  });

  it('does not let a colleague approve a refund on someone else’s mandate', async () => {
    const mandateId = await newMandate(owner);
    const { intentId, auth } = await authorizedIntent(mandateId);

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

    await app.inject({
      method: 'POST',
      url: `/v1/intents/${intentId}/delivery`,
      headers: asAgent,
      payload: {
        evidence: {
          evidenceVersion: 1,
          status: 'failed',
          trackingId: 'TRK-1',
          shippedAt: iso(-DAY),
        },
      },
    });
    const settled = await app.inject({
      method: 'POST',
      url: `/v1/intents/${intentId}/settle`,
      headers: asAgent,
    });
    const settlementId = settled.json().settlementId;
    expect(settled.json().recommendation).toBe('full_refund');

    const stolen = await app.inject({
      method: 'POST',
      url: `/v1/settlements/${settlementId}/execute`,
      headers: { ...asColleague, ...idem() },
      payload: { confirmRefundAmountPaise: settled.json().refundAmountPaise },
    });
    expect(stolen.statusCode).toBe(403);

    // And no money moved.
    const intent = await prisma.paymentIntent.findUnique({ where: { id: intentId } });
    expect(intent?.refundedAmountPaise).toBe(0n);

    // The owner can.
    const allowed = await app.inject({
      method: 'POST',
      url: `/v1/settlements/${settlementId}/execute`,
      headers: { ...asOwner, ...idem() },
      payload: { confirmRefundAmountPaise: settled.json().refundAmountPaise },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it('scopes the audit trail to the caller’s tenant', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/audit', headers: asOwner });
    expect(res.statusCode).toBe(200);
    const foreign = res
      .json()
      .events.filter((e: { tenantId?: string }) => e.tenantId && e.tenantId !== tenantId);
    expect(foreign).toHaveLength(0);
  });
});

// --------------------------------------------------------------------------

describe('approval link', () => {
  it('opens once for a valid link', async () => {
    const mandateId = await newMandate(owner);
    const { approvalUrl } = await authorizedIntent(mandateId);

    const page = await app.inject({ method: 'GET', url: approvalUrl });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Approve this payment');
    expect(page.body).toContain('checkout.razorpay.com/v1/checkout.js');
  });

  it('does not consume the link merely by loading the page', async () => {
    const mandateId = await newMandate(owner);
    const { approvalUrl } = await authorizedIntent(mandateId);

    await app.inject({ method: 'GET', url: approvalUrl });
    const second = await app.inject({ method: 'GET', url: approvalUrl });
    expect(second.statusCode).toBe(200);
  });

  it('refuses a replayed link — the second start is rejected', async () => {
    const mandateId = await newMandate(owner);
    const { approvalUrl } = await authorizedIntent(mandateId);

    const first = await app.inject({ method: 'POST', url: `${approvalUrl}/start` });
    expect(first.statusCode).toBe(200);

    const replay = await app.inject({ method: 'POST', url: `${approvalUrl}/start` });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().detail.code).toBe('TOKEN_ALREADY_USED');
  });

  it('shows a used link as spent rather than re-opening it', async () => {
    const mandateId = await newMandate(owner);
    const { approvalUrl } = await authorizedIntent(mandateId);

    await app.inject({ method: 'POST', url: `${approvalUrl}/start` });
    const page = await app.inject({ method: 'GET', url: approvalUrl });
    expect(page.statusCode).toBe(409);
    expect(page.body).toContain('already been used');
  });

  it('refuses an expired link', async () => {
    const mandateId = await newMandate(owner);
    const { intentId, approvalUrl } = await authorizedIntent(mandateId);

    await prisma.approvalToken.updateMany({
      where: { intentId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const page = await app.inject({ method: 'GET', url: approvalUrl });
    expect(page.statusCode).toBe(409);
    expect(page.body).toContain('expired');

    const start = await app.inject({ method: 'POST', url: `${approvalUrl}/start` });
    expect(start.statusCode).toBe(409);
    expect(start.json().detail.code).toBe('TOKEN_EXPIRED');
  });

  it('refuses a guessed or unknown token', async () => {
    const res = await app.inject({ method: 'GET', url: `/approve/${randomUUID()}` });
    expect(res.statusCode).toBe(404);

    const start = await app.inject({ method: 'POST', url: `/approve/${randomUUID()}/start` });
    expect(start.statusCode).toBe(404);
  });

  it('stores only a hash of the token', async () => {
    const mandateId = await newMandate(owner);
    const { intentId, approvalUrl } = await authorizedIntent(mandateId);
    const plain = approvalUrl.split('/').pop()!;

    const row = await prisma.approvalToken.findFirst({ where: { intentId } });
    expect(row?.tokenHash).not.toBe(plain);
    expect(row?.tokenHash).toHaveLength(64);
  });

  it('refuses to open after the mandate is revoked', async () => {
    const mandateId = await newMandate(owner);
    const { approvalUrl } = await authorizedIntent(mandateId);

    // The link was minted while the mandate was live; the human clicks after
    // it was withdrawn.
    await app.inject({
      method: 'POST',
      url: `/v1/mandates/${mandateId}/revoke`,
      headers: asOwner,
      payload: { reason: 'changed my mind' },
    });

    const page = await app.inject({ method: 'GET', url: approvalUrl });
    expect(page.statusCode).toBe(409);
    expect(page.body).toContain('REVOKED');

    const start = await app.inject({ method: 'POST', url: `${approvalUrl}/start` });
    expect(start.statusCode).toBe(409);
    expect(start.json().detail.code).toBe('REVOKED');
  });

  it('refuses to open when the quote drifted after the link was minted', async () => {
    const mandateId = await newMandate(owner);
    const { intentId, approvalUrl } = await authorizedIntent(mandateId);

    // The merchant reprices between the agent asking and the human clicking.
    await prisma.quote.updateMany({
      where: { intentId },
      data: {
        structuredJson: JSON.stringify({
          ...quote({
            lineItems: [
              {
                sku: 'SKU-KEYBOARD-MX',
                unitPricePaise: '500000',
                quantity: 1,
                lineTotalPaise: '500000',
              },
            ],
            subtotalPaise: '500000',
            totalPaise: '500000',
          }),
        }),
        totalPaise: 500000n,
      },
    });

    const page = await app.inject({ method: 'GET', url: approvalUrl });
    expect(page.statusCode).toBe(409);
    expect(page.body).toContain('no longer matches');

    const start = await app.inject({ method: 'POST', url: `${approvalUrl}/start` });
    expect(start.statusCode).toBe(409);
    expect(start.json().detail.code).toBe('BLOCKED_BY_DRIFT');
    expect(
      start.json().detail.violations.map((v: { ruleId: string }) => v.ruleId),
    ).toContain('TOTAL_EXCEEDS_MANDATE_CEILING');
  });

  it('refuses when the link no longer belongs to the mandate owner', async () => {
    const mandateId = await newMandate(owner);
    const { intentId, approvalUrl } = await authorizedIntent(mandateId);

    // Re-point the token at a different person, as a stolen-and-reused link
    // or a mis-issued one would look.
    await prisma.approvalToken.updateMany({
      where: { intentId },
      data: { principalId: colleague.id },
    });

    const page = await app.inject({ method: 'GET', url: approvalUrl });
    expect(page.statusCode).toBe(409);
    expect(page.body).toContain('NOT_MANDATE_OWNER');
  });

  it('says so plainly when no gateway key is configured', async () => {
    const mandateId = await newMandate(owner);
    const { approvalUrl } = await authorizedIntent(mandateId);

    const start = await app.inject({ method: 'POST', url: `${approvalUrl}/start` });
    expect(start.json().checkoutAvailable).toBe(false);
  });
});

// --------------------------------------------------------------------------

describe('the audit trail records the refusals', () => {
  it('still verifies after every attack above', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/audit/verify',
      headers: asOwner,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });
});
