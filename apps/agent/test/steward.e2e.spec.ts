/**
 * Full-stack E2E: real Fastify server, real SQLite database (WASM Prisma +
 * libsql), real Strands agent loop, fake Razorpay gateway. Same story as
 * src/demo.ts, asserted instead of narrated.
 *
 * Gated on STEWARD_E2E=1 (see vitest.config.ts) so the default test command
 * stays hermetic; CI runs it after the schema push.
 */
import { randomUUID } from 'node:crypto';

import '../src/demo-bootstrap.js';
import { asFakeGateway, buildServer, getGateway, loadConfig, resetGateway } from '@razortrust/api';
import { prisma } from '@razortrust/db';
import { generateEd25519KeyPair } from '@razortrust/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runCycle } from '../src/cycle.js';
import { InjectRazorTrustClient, injectRequester } from '../src/inject-client.js';
import { provisionCafeScenario } from '../src/provision.js';
import { ScriptedModel } from '../src/scripted-model.js';
import { InMemoryJournal, InMemoryMailbox, InMemoryOutbox } from '../src/state.js';
import type { FastifyInstance } from 'fastify';

describe('steward full story (real server + database)', () => {
  let app: FastifyInstance;
  let gateway: ReturnType<typeof asFakeGateway>;
  let values: Awaited<ReturnType<typeof provisionCafeScenario>>;
  let api: InjectRazorTrustClient;
  let request: ReturnType<typeof injectRequester>;

  const outbox = new InMemoryOutbox();
  const journal = new InMemoryJournal();
  const mailbox = new InMemoryMailbox();

  beforeAll(async () => {
    resetGateway();
    // Out-of-band trust anchor for signed audit checkpoints.
    const auditKeys = generateEd25519KeyPair();
    const config = loadConfig({
      ...process.env,
      LOG_LEVEL: 'fatal',
      RAZORPAY_KEY_ID: '',
      RAZORPAY_KEY_SECRET: '',
      RAZORPAY_WEBHOOK_SECRET: 'e2e_webhook_secret',
      ANTHROPIC_API_KEY: '',
      QUOTE_STRUCTURER: 'deterministic',
      AUDIT_CHECKPOINT_PRIVATE_KEY_PEM: auditKeys.privateKeyPem,
      AUDIT_CHECKPOINT_PUBLIC_KEY_PEM: auditKeys.publicKeyPem,
      AUDIT_CHECKPOINT_EVERY_N_EVENTS: '8',
    });
    app = await buildServer(config);
    gateway = asFakeGateway(getGateway(config));
    request = injectRequester(app);
    values = await provisionCafeScenario(request, Date.now() - 2 * 24 * 60 * 60 * 1000);
    api = new InjectRazorTrustClient(app, values.agentToken);
    for (const message of [
      values.fixture.messages.validQuote,
      values.fixture.messages.overPriceCap,
      values.fixture.messages.injectedQuote,
    ]) {
      mailbox.add(message);
    }
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('cycle 1: one hold request, two mandate blocks, no money moved', async () => {
    const result = await runCycle({
      model: new ScriptedModel(),
      api,
      mailbox,
      outbox,
      journal,
      mandateId: values.mandateId,
    });

    const decisions = result.notifications.filter((n) => n.kind === 'decision_required');
    const blocks = result.notifications.filter((n) => n.kind === 'blocked');
    expect(result.processed).toBe(3);
    expect(decisions).toHaveLength(1);
    expect(blocks).toHaveLength(2);
    expect(decisions[0]!.actionUrl).toMatch(/^\/approve\//);
  });

  it('human completes checkout, then the sweep captures the hold', async () => {
    const entry = (await journal.all()).find((e) => e.merchantQuoteRef === 'Q-1001')!;
    const authorization = await prisma.authorization.findUnique({
      where: { intentId: entry.intentId },
    });
    expect(authorization?.captureMode).toBe('manual');
    expect(authorization?.capturedAt).toBeNull();

    const payment = gateway.simulateCustomerAuthorization(authorization!.rzpOrderId);
    const hook = gateway.buildWebhook('payment.authorized', { payment });
    const webhook = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/razorpay',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': hook.signature,
        'x-razorpay-event-id': hook.eventId,
      },
      payload: hook.body,
    });
    expect(webhook.statusCode).toBe(200);

    await runCycle({
      model: new ScriptedModel(),
      api,
      mailbox: new InMemoryMailbox(),
      outbox,
      journal,
      mandateId: values.mandateId,
      sweep: true,
    });

    const intent = await request({
      method: 'GET',
      path: `/v1/intents/${entry.intentId}`,
      token: values.agentToken,
    });
    expect(intent.body.state).toBe('captured');
  });

  it('cycle 3: short delivery recommends a partial refund the agent cannot execute', async () => {
    const result = await runCycle({
      model: new ScriptedModel(),
      api,
      mailbox: new InMemoryMailbox([values.fixture.messages.shortDelivery]),
      outbox,
      journal,
      mandateId: values.mandateId,
    });

    const decision = result.notifications.find(
      (n) => n.kind === 'decision_required' && /refund/i.test(n.title),
    );
    expect(decision?.data?.settlementId).toEqual(expect.any(String));
    expect(decision?.data?.refundAmountPaise).toBe('235000');
  });

  it('the owner executes the recommended refund and the audit chain verifies', async () => {
    const refund = [...outbox.notifications]
      .reverse()
      .find((n) => n.kind === 'decision_required' && n.data?.settlementId);
    const execute = await request({
      method: 'POST',
      path: `/v1/settlements/${refund!.data!.settlementId}/execute`,
      token: values.principalToken,
      idempotencyKey: randomUUID(),
      payload: { confirmRefundAmountPaise: refund!.data!.refundAmountPaise },
    });
    expect(execute.ok).toBe(true);
    expect(execute.body.amountPaise).toBe('235000');

    // The agent's own token must not be able to do the same on another attempt.
    const agentForbidden = await request({
      method: 'POST',
      path: `/v1/settlements/${refund!.data!.settlementId}/execute`,
      token: values.agentToken,
      idempotencyKey: randomUUID(),
      payload: { confirmRefundAmountPaise: refund!.data!.refundAmountPaise },
    });
    expect([403, 409]).toContain(agentForbidden.status);

    const checkpoint = await request({
      method: 'POST',
      path: '/v1/audit/checkpoint',
      token: values.principalToken,
    });
    expect(checkpoint.status).toBe(201);

    const verification = await request({
      method: 'GET',
      path: '/v1/audit/verify',
      token: values.principalToken,
    });
    expect(verification.body.ok).toBe(true);
    expect(verification.body.mode).toBe('checkpointed');
  });
});
