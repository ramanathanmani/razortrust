/**
 * The full payment lifecycle against the fake gateway.
 *
 * The happy path is the least interesting part of this file. What matters is
 * the section on failure modes: an ambiguous capture, a hold released because
 * the mandate was revoked mid-flight, a deadline that has passed, and a
 * webhook replayed three times.
 */
import { randomUUID } from 'node:crypto';

import { FakeGateway } from '@razortrust/adapters';
import { generateEd25519KeyPair, signCanonical, signingEnvelope } from '@razortrust/core';
import { prisma } from '@razortrust/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hashApiKey } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { asFakeGateway, getGateway, resetGateway } from '../src/gateway.js';
import { buildServer } from '../src/server.js';
import { runSweep } from '../src/sweeper.js';

const suffix = randomUUID().slice(0, 8);
const tenantId = `t_pay_${suffix}`;
const principalId = `p_pay_${suffix}`;
const agentId = `a_pay_${suffix}`;
const merchantRef = `m_pay_${suffix}`;
const apiKey = `rzt_agent_${randomUUID().replace(/-/g, '')}`;
const principalKey = `rzt_principal_${randomUUID().replace(/-/g, '')}`;
const keys = generateEd25519KeyPair();

let app: FastifyInstance;
let fake: FakeGateway;
let config: ReturnType<typeof loadConfig>;

const asPrincipal = { authorization: `Bearer ${principalKey}` };
const asAgent = { authorization: `Bearer ${apiKey}` };
const idem = () => ({ 'idempotency-key': randomUUID() });

function quote(overrides: Record<string, unknown> = {}) {
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
    promisedDeliveryAt: '2026-09-01T00:00:00.000Z',
    capturedAt: '2026-08-28T11:55:00.000Z',
    ...overrides,
  };
}

/** Draft + sign + activate a fresh mandate. */
async function newMandate() {
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
      deliveryWindow: { startsAt: '2026-08-29T00:00:00.000Z', endsAt: '2026-09-05T00:00:00.000Z' },
      notBefore: '2026-08-28T00:00:00.000Z',
      notAfter: '2026-09-04T00:00:00.000Z',
      captureDeadlineHours: 72,
      autoRefundAllowed: false,
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

/** Drive an intent all the way to an authorized hold. */
async function holdFor(mandateId: string, q: unknown = quote()) {
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

  return { intentId, authorizeResponse: auth };
}

/** The human completes checkout, and the gateway tells us so. */
async function completeCheckout(orderId: string) {
  const payment = fake.simulateCustomerAuthorization(orderId);
  const hook = fake.buildWebhook('payment.authorized', { payment });
  const res = await app.inject({
    method: 'POST',
    url: '/v1/webhooks/razorpay',
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': hook.signature,
      'x-razorpay-event-id': hook.eventId,
    },
    payload: hook.body,
  });
  expect(res.statusCode).toBe(200);
  return payment;
}

beforeAll(async () => {
  resetGateway();
  config = loadConfig({
    ...process.env,
    LOG_LEVEL: 'fatal',
    RAZORPAY_KEY_ID: '',
    RAZORPAY_KEY_SECRET: '',
    RAZORPAY_WEBHOOK_SECRET: 'test_webhook_secret',
  });
  app = await buildServer(config);
  fake = asFakeGateway(getGateway(config));

  await prisma.tenant.create({ data: { id: tenantId, name: `Payments ${suffix}` } });
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
    data: { id: `mm_${suffix}`, tenantId, displayName: 'Depot', externalRef: merchantRef },
  });
});

afterAll(async () => {
  await app.close();
  resetGateway();
  await prisma.$disconnect();
});

describe('authorization', () => {
  it('creates a manual-capture order and hands back a one-time approval link', async () => {
    const mandateId = await newMandate();
    const { authorizeResponse } = await holdFor(mandateId);

    expect(authorizeResponse.statusCode).toBe(201);
    const body = authorizeResponse.json();
    expect(body.captureMode).toBe('manual');
    // The agent gets a link for a human, not a payment it can complete.
    expect(body.approvalUrl).toMatch(/^\/approve\/[0-9a-f]{64}$/);
    expect(new Date(body.approvalExpiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(body.state).toBe('awaiting_authorization');
  });

  it('does not let the agent hold money on a drifted quote', async () => {
    const mandateId = await newMandate();
    const { authorizeResponse } = await holdFor(
      mandateId,
      quote({ unitPriceOverride: undefined, totalPaise: '260000', subtotalPaise: '260000',
        lineItems: [
          { sku: 'SKU-KEYBOARD-MX', unitPricePaise: '260000', quantity: 1, lineTotalPaise: '260000' },
        ] }),
    );
    expect(authorizeResponse.statusCode).toBe(422);
    expect(authorizeResponse.json().error).toBe('BLOCKED_BY_DRIFT');
  });

  it('records the hold and its deadline only once a human completes checkout', async () => {
    const mandateId = await newMandate();
    const { intentId, authorizeResponse } = await holdFor(mandateId);

    const before = await prisma.paymentIntent.findUnique({ where: { id: intentId } });
    expect(before?.state).toBe('awaiting_authorization');

    await completeCheckout(authorizeResponse.json().orderId);

    const after = await prisma.paymentIntent.findUnique({
      where: { id: intentId },
      include: { authorization: true },
    });
    expect(after?.state).toBe('authorized');
    expect(after?.authorization?.captureDeadline).toBeTruthy();

    // 72 hours, not a minute more.
    const held =
      after!.authorization!.captureDeadline!.getTime() -
      after!.authorization!.authorizedAt!.getTime();
    expect(held).toBe(72 * 3_600_000);
  });
});

describe('capture', () => {
  it('captures a clean hold', async () => {
    const mandateId = await newMandate();
    const { intentId, authorizeResponse } = await holdFor(mandateId);
    await completeCheckout(authorizeResponse.json().orderId);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/intents/${intentId}/capture`,
      headers: { ...asAgent, ...idem() },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe('captured');
    expect(res.json().capturedAmountPaise).toBe('175000');
  });

  it('refuses to capture when the mandate was revoked after the hold', async () => {
    const mandateId = await newMandate();
    const { intentId, authorizeResponse } = await holdFor(mandateId);
    await completeCheckout(authorizeResponse.json().orderId);

    await app.inject({
      method: 'POST',
      url: `/v1/mandates/${mandateId}/revoke`,
      headers: asPrincipal,
      payload: { reason: 'Changed my mind' },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/intents/${intentId}/capture`,
      headers: { ...asAgent, ...idem() },
    });

    expect(res.statusCode).toBe(403);
    // And the money is given back, not kept.
    const after = await prisma.paymentIntent.findUnique({ where: { id: intentId } });
    expect(after?.state).toBe('released');
  });

  it('refuses to capture past the deadline, with no sweeper involved', async () => {
    const mandateId = await newMandate();
    const { intentId, authorizeResponse } = await holdFor(mandateId);
    await completeCheckout(authorizeResponse.json().orderId);

    // Wind the deadline into the past.
    await prisma.authorization.update({
      where: { intentId },
      data: { captureDeadline: new Date(Date.now() - 1000) },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/intents/${intentId}/capture`,
      headers: { ...asAgent, ...idem() },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('CAPTURE_WINDOW_CLOSED');
    expect(res.json().detail.code).toBe('DEADLINE_PASSED');
  });

  it('refuses inside the safety margin rather than racing the gateway', async () => {
    const mandateId = await newMandate();
    const { intentId, authorizeResponse } = await holdFor(mandateId);
    await completeCheckout(authorizeResponse.json().orderId);

    await prisma.authorization.update({
      where: { intentId },
      data: { captureDeadline: new Date(Date.now() + 5_000) },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/intents/${intentId}/capture`,
      headers: { ...asAgent, ...idem() },
    });
    expect(res.json().detail.code).toBe('WITHIN_SAFETY_MARGIN');
  });

  it('cannot capture an intent that was never authorized', async () => {
    const mandateId = await newMandate();
    const { intentId } = await holdFor(mandateId);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/intents/${intentId}/capture`,
      headers: { ...asAgent, ...idem() },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('ambiguous capture — the case that matters', () => {
  it('reconciles a capture that succeeded but reported a timeout', async () => {
    const mandateId = await newMandate();
    const { intentId, authorizeResponse } = await holdFor(mandateId);
    await completeCheckout(authorizeResponse.json().orderId);

    // The gateway captures, then the connection dies. The caller sees only
    // the error, and has no way to know the money moved.
    fake.injectFault({ captureSucceedsButTimesOut: true });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/intents/${intentId}/capture`,
      headers: { ...asAgent, ...idem() },
    });

    // Reconciliation asks the gateway and finds the truth.
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe('captured');
    expect(res.json().note).toContain('gateway confirms');

    const after = await prisma.paymentIntent.findUnique({ where: { id: intentId } });
    expect(after?.state).toBe('captured');
    expect(after?.capturedAmountPaise).toBe(175000n);
  });

  it('returns the hold to authorized when an ambiguous failure captured nothing', async () => {
    const mandateId = await newMandate();
    const { intentId, authorizeResponse } = await holdFor(mandateId);
    await completeCheckout(authorizeResponse.json().orderId);

    fake.injectFault({ captureAmbiguousFailure: true });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/intents/${intentId}/capture`,
      headers: { ...asAgent, ...idem() },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('CAPTURE_OUTCOME_UNKNOWN');

    // Reconciliation found the hold intact, so it is safe to try again.
    const after = await prisma.paymentIntent.findUnique({ where: { id: intentId } });
    expect(after?.state).toBe('authorized');

    const retry = await app.inject({
      method: 'POST',
      url: `/v1/intents/${intentId}/capture`,
      headers: { ...asAgent, ...idem() },
    });
    expect(retry.statusCode).toBe(200);
  });

  it('does not mark a terminal failure as captured', async () => {
    const mandateId = await newMandate();
    const { intentId, authorizeResponse } = await holdFor(mandateId);
    await completeCheckout(authorizeResponse.json().orderId);

    fake.injectFault({ captureTerminalFailure: 'BAD_REQUEST_ERROR' });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/intents/${intentId}/capture`,
      headers: { ...asAgent, ...idem() },
    });
    expect(res.statusCode).toBe(502);

    const after = await prisma.paymentIntent.findUnique({ where: { id: intentId } });
    expect(after?.state).toBe('authorized');
  });
});

describe('release', () => {
  it('releases an uncaptured hold in full', async () => {
    const mandateId = await newMandate();
    const { intentId, authorizeResponse } = await holdFor(mandateId);
    await completeCheckout(authorizeResponse.json().orderId);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/intents/${intentId}/release`,
      headers: asAgent,
      payload: { reason: 'no longer needed' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().method).toBe('reversal');
  });

  it('reports gateway_expiry honestly when reversal is unsupported', async () => {
    const mandateId = await newMandate();
    const { intentId, authorizeResponse } = await holdFor(mandateId);
    await completeCheckout(authorizeResponse.json().orderId);

    fake.injectFault({ releaseUnsupported: true });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/intents/${intentId}/release`,
      headers: asAgent,
    });

    expect(res.json().method).toBe('gateway_expiry');
    expect(res.json().note).toContain('3-day auto-refund');
  });

  it('gives the amount back to the mandate ceiling but not the use', async () => {
    const mandateId = await newMandate();
    const before = await prisma.mandate.findUnique({ where: { id: mandateId } });

    const { intentId, authorizeResponse } = await holdFor(mandateId);
    await completeCheckout(authorizeResponse.json().orderId);

    const held = await prisma.mandate.findUnique({ where: { id: mandateId } });
    expect(held?.cumulativeAuthorizedPaise).toBe(175000n);
    expect(held?.usesCount).toBe(before!.usesCount + 1);

    await app.inject({
      method: 'POST',
      url: `/v1/intents/${intentId}/release`,
      headers: asAgent,
    });

    const after = await prisma.mandate.findUnique({ where: { id: mandateId } });
    expect(after?.cumulativeAuthorizedPaise).toBe(0n);
    // The use is NOT returned, so an agent cannot churn holds forever.
    expect(after?.usesCount).toBe(before!.usesCount + 1);
  });

  it('refuses to release a captured payment', async () => {
    const mandateId = await newMandate();
    const { intentId, authorizeResponse } = await holdFor(mandateId);
    await completeCheckout(authorizeResponse.json().orderId);
    await app.inject({
      method: 'POST',
      url: `/v1/intents/${intentId}/capture`,
      headers: { ...asAgent, ...idem() },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/intents/${intentId}/release`,
      headers: asAgent,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain('refund');
  });
});

describe('webhooks', () => {
  it('rejects a body whose signature does not verify', async () => {
    const mandateId = await newMandate();
    const { authorizeResponse } = await holdFor(mandateId);
    const payment = fake.simulateCustomerAuthorization(authorizeResponse.json().orderId);
    const hook = fake.buildWebhook('payment.authorized', { payment });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/razorpay',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': 'f'.repeat(64),
        'x-razorpay-event-id': hook.eventId,
      },
      payload: hook.body,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('INVALID_SIGNATURE');
  });

  it('ignores a replay instead of advancing state twice', async () => {
    const mandateId = await newMandate();
    const { intentId, authorizeResponse } = await holdFor(mandateId);
    const payment = fake.simulateCustomerAuthorization(authorizeResponse.json().orderId);
    const hook = fake.buildWebhook('payment.authorized', { payment });

    const headers = {
      'content-type': 'application/json',
      'x-razorpay-signature': hook.signature,
      'x-razorpay-event-id': hook.eventId,
    };

    const first = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/razorpay',
      headers,
      payload: hook.body,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/razorpay',
      headers,
      payload: hook.body,
    });
    const third = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/razorpay',
      headers,
      payload: hook.body,
    });

    expect(first.json().status).toBe('ok');
    expect(second.json().status).toBe('duplicate_ignored');
    expect(third.json().status).toBe('duplicate_ignored');

    const intent = await prisma.paymentIntent.findUnique({ where: { id: intentId } });
    expect(intent?.state).toBe('authorized');
  });

  it('treats a capture webhook arriving first as confirmation, not a transition', async () => {
    const mandateId = await newMandate();
    const { intentId, authorizeResponse } = await holdFor(mandateId);
    const payment = await completeCheckout(authorizeResponse.json().orderId);

    // The gateway tells us about the capture before we ever call capture.
    const captured = { ...payment, status: 'captured' as const, captured: true };
    const hook = fake.buildWebhook('payment.captured', { payment: captured });
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

    const intent = await prisma.paymentIntent.findUnique({ where: { id: intentId } });
    expect(intent?.state).toBe('captured');

    // And our own capture call now refuses, rather than double-capturing.
    const res = await app.inject({
      method: 'POST',
      url: `/v1/intents/${intentId}/capture`,
      headers: { ...asAgent, ...idem() },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('the sweeper is cleanup, not safety', () => {
  it('marks a lapsed hold released and returns the ceiling', async () => {
    const mandateId = await newMandate();
    const { intentId, authorizeResponse } = await holdFor(mandateId);
    await completeCheckout(authorizeResponse.json().orderId);

    await prisma.authorization.update({
      where: { intentId },
      data: { captureDeadline: new Date(Date.now() - 60_000) },
    });

    const result = await runSweep({ config, gateway: fake });
    expect(result.lapsedHolds).toBeGreaterThanOrEqual(1);

    const after = await prisma.paymentIntent.findUnique({ where: { id: intentId } });
    expect(after?.state).toBe('released');

    const mandate = await prisma.mandate.findUnique({ where: { id: mandateId } });
    expect(mandate?.cumulativeAuthorizedPaise).toBe(0n);
  });

  it('is not required for the deadline to be enforced', async () => {
    // Same setup, but capture is called WITHOUT ever running a sweep.
    const mandateId = await newMandate();
    const { intentId, authorizeResponse } = await holdFor(mandateId);
    await completeCheckout(authorizeResponse.json().orderId);

    await prisma.authorization.update({
      where: { intentId },
      data: { captureDeadline: new Date(Date.now() - 60_000) },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/intents/${intentId}/capture`,
      headers: { ...asAgent, ...idem() },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('the audit trail covers the money', () => {
  it('records the full lifecycle in the chain', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/audit', headers: asPrincipal });
    const types = res.json().events.map((e: { eventType: string }) => e.eventType);

    expect(types).toEqual(
      expect.arrayContaining([
        'authorization.requested',
        'authorization.succeeded',
        'capture.requested',
        'capture.succeeded',
        'capture.failed',
        'capture.deadline_check_failed',
        'authorization.release_requested',
        'authorization.released',
        'webhook.received',
        'webhook.replay_rejected',
      ]),
    );
  });

  it('still verifies after every one of those failure paths', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/audit/verify',
      headers: asPrincipal,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });
});
