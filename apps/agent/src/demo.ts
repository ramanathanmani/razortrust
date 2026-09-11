/**
 * The Steward narrated demo.
 *
 * Real server, real database, real Strands agent loop, fake gateway — nothing
 * is staged. It is the reference story judges see in the video:
 *
 *   Cycle 1 - three quote emails land overnight
 *     Q-1001 ordinary restock      -> hold created, one-time approval link surfaced
 *     Q-1002 over the price cap    -> blocked, no money touched
 *     Q-1003 prompt injection      -> blocked on arithmetic + ceiling
 *   Human moment 1 - the owner completes checkout for Q-1001
 *   Cycle 2 - the sweep captures the approved hold
 *   Cycle 3 - Q-1001 arrives a kilogram short
 *     settlement recommends a partial refund, the agent is REFUSED the
 *     execute call (ordinary mandates require a human), and the owner is
 *     surfaced the exact decision
 *   Human moment 2 - the owner approves the refund
 *   Audit chain verified.
 */
import { randomUUID } from 'node:crypto';

import './demo-bootstrap.js';
import { asFakeGateway, buildServer, getGateway, loadConfig, resetGateway } from '@razortrust/api';
import { prisma } from '@razortrust/db';
import { generateEd25519KeyPair } from '@razortrust/core';

import { runCycle, formatDigest } from './cycle.js';
import { InjectRazorTrustClient, injectRequester } from './inject-client.js';
import { ScriptedModel } from './scripted-model.js';
import { InMemoryJournal, InMemoryMailbox, InMemoryOutbox } from './state.js';
import { provisionCafeScenario } from './provision.js';

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};
const line = (s: string) => console.log(s);
const heading = (n: string, title: string) => {
  line(`\n${C.bold}${C.blue}${'─'.repeat(72)}${C.reset}`);
  line(`${C.bold}${C.blue}${n}${C.reset} ${title}`);
  line(`${C.bold}${C.blue}${'─'.repeat(72)}${C.reset}`);
};
const owner = (s: string) => line(`  ${C.magenta}OWNER ${C.reset} ${s}`);
const agent = (s: string) => line(`  ${C.cyan}STEWARD${C.reset} ${s}`);
const world = (s: string) => line(`  ${C.dim}WORLD  ${C.dim}${s}${C.reset}`);
const good = (s: string) => line(`  ${C.green}✓${C.reset} ${s}`);
const bad = (s: string) => line(`  ${C.red}✗${C.reset} ${s}`);
const quiet = (s: string) => line(`         ${C.dim}${s}${C.reset}`);

async function main() {
  resetGateway();
  // Ephemeral checkpoint key standing in for the out-of-band trust anchor:
  // the verify route only accepts checkpoints signed by THIS public key.
  const auditKeys = generateEd25519KeyPair();
  const config = loadConfig({
    ...process.env,
    LOG_LEVEL: 'fatal',
    RAZORPAY_KEY_ID: '',
    RAZORPAY_KEY_SECRET: '',
    RAZORPAY_WEBHOOK_SECRET: 'demo_webhook_secret',
    ANTHROPIC_API_KEY: '',
    QUOTE_STRUCTURER: 'deterministic',
    AUDIT_CHECKPOINT_PRIVATE_KEY_PEM: auditKeys.privateKeyPem,
    AUDIT_CHECKPOINT_PUBLIC_KEY_PEM: auditKeys.publicKeyPem,
    AUDIT_CHECKPOINT_EVERY_N_EVENTS: '8',
  });
  const app = await buildServer(config);
  const gateway = asFakeGateway(getGateway(config));

  const request = injectRequester(app);
  // The story spans two days: quotes arrived overnight two days ago, and the
  // goods have now been delivered. The fixture clock starts then; the live
  // API, database and gateway still run on the real clock.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const scenario = await provisionCafeScenario(request, Date.now() - 2 * DAY_MS);
  const { fixture, mandateId, agentToken, principalToken } = scenario;

  const mailbox = new InMemoryMailbox([
    fixture.messages.validQuote,
    fixture.messages.overPriceCap,
    fixture.messages.injectedQuote,
  ]);
  const outbox = new InMemoryOutbox();
  const journal = new InMemoryJournal();
  const api = new InjectRazorTrustClient(app, agentToken);

  line(`\n${C.bold}Steward — a background reordering agent that can only pay inside a mandate.${C.reset}`);
  line(`${C.dim}Strands Agents SDK · real RazorTrust API · real database · fake gateway · scripted model (zero credits).${C.reset}`);
  quiet(`The signed mandate: two SKUs, ₹8,000 per payment, ₹30,000 cumulative, one supplier.`);
  quiet(`Steward holds the agent token. The owner's token and signing key never enter the agent.`);

  // ---- CYCLE 1: the overnight mailbox -------------------------------------
  heading('CYCLE 1', 'three supplier emails arrive while the cafe is closed');
  world('Mailbox: Q-1001 (restock), Q-1002 (premium pricing), Q-1003 ("URGENT")');
  agent('I work each email in arrival order, one Strands tool loop per message.');
  const cycle1 = await runCycle({
    model: new ScriptedModel(),
    api,
    mailbox,
    outbox,
    journal,
    mandateId,
  });
  line(`\n${C.bold}Steward's digest:${C.reset}`);
  line(formatDigest(cycle1));

  // Assert the story invariants; a broken control fails the demo loudly.
  const decisions1 = cycle1.notifications.filter((n) => n.kind === 'decision_required');
  const blocked1 = cycle1.notifications.filter((n) => n.kind === 'blocked');
  if (decisions1.length !== 1 || blocked1.length !== 2) {
    throw new Error(`Cycle 1 expected 1 decision + 2 blocks, got ${decisions1.length}/${blocked1.length}`);
  }
  good('Exactly one hold was requested (Q-1001); two quotes were refused and never touched money.');

  // ---- HUMAN MOMENT 1: checkout ------------------------------------------
  heading('HUMAN MOMENT 1', 'the owner taps the one-time approval link');
  const q1001Entry = (await journal.all()).find((e) => e.merchantQuoteRef === 'Q-1001');
  if (!q1001Entry) throw new Error('Q-1001 never made it into the journal');
  const authorization = await prisma.authorization.findUnique({ where: { intentId: q1001Entry.intentId } });
  if (!authorization?.rzpOrderId) throw new Error('Q-1001 hold did not create an order');
  owner(`Opens /approve link, checks the figures, completes Razorpay checkout.`);
  const payment = gateway.simulateCustomerAuthorization(authorization.rzpOrderId);
  const hook = gateway.buildWebhook('payment.authorized', { payment });
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
  world('Gateway webhook: payment authorized. The hold now exists; money has not moved.');

  // ---- CYCLE 2: sweep & capture ------------------------------------------
  heading('CYCLE 2', 'the sweep captures the hold the owner approved');
  agent('Sweep pass: any AUTHORIZED hold inside its capture window gets captured now.');
  const cycle2 = await runCycle({
    model: new ScriptedModel(),
    api,
    mailbox: new InMemoryMailbox(),
    outbox,
    journal,
    mandateId,
    sweep: true,
  });
  const captured = await request({
    method: 'GET',
    path: `/v1/intents/${q1001Entry.intentId}`,
    token: agentToken,
  });
  if (captured.body.state !== 'captured') {
    throw new Error(`Expected captured after sweep, got ${captured.body.state}`);
  }
  good(`Q-1001 captured ${captured.body.capturedAmountPaise} paise — after re-verification and re-checking every rule.`);
  line(C.dim + formatDigest(cycle2) + C.reset);

  // ---- CYCLE 3: short delivery + settlement ------------------------------
  heading('CYCLE 3', 'Q-1001 arrives a kilogram short');
  world('Carrier note: 2 coffee bags ordered, 1 delivered. Cups complete.');
  agent('I record what arrived and ask the settlement engine what is owed.');
  const deliveryMailbox = new InMemoryMailbox([fixture.messages.shortDelivery]);
  const cycle3 = await runCycle({
    model: new ScriptedModel(),
    api,
    mailbox: deliveryMailbox,
    outbox,
    journal,
    mandateId,
  });
  line(`\n${C.bold}Steward's digest:${C.reset}`);
  line(formatDigest(cycle3));

  const refundDecision = cycle3.notifications.find(
    (n) => n.kind === 'decision_required' && /refund/i.test(n.title),
  );
  if (!refundDecision?.data?.settlementId) {
    throw new Error('Expected a human-gated refund decision with a settlement id');
  }
  bad('The agent CALLED execute_refund itself and was refused: ordinary mandates need a human.');

  // ---- HUMAN MOMENT 2: approve the refund --------------------------------
  heading('HUMAN MOMENT 2', 'the owner confirms the exact recommended amount');
  const settlementId = refundDecision.data.settlementId as string;
  const amount = refundDecision.data.refundAmountPaise as string;
  const humanExecute = await request({
    method: 'POST',
    path: `/v1/settlements/${settlementId}/execute`,
    token: principalToken,
    idempotencyKey: randomUUID(),
    payload: { confirmRefundAmountPaise: amount },
  });
  if (!humanExecute.ok) throw new Error(`Owner refund failed: ${JSON.stringify(humanExecute.body)}`);
  good(`Partial refund of ${humanExecute.body.amountPaise} paise executed by the owner (${humanExecute.body.state}).`);

  // ---- AUDIT --------------------------------------------------------------
  heading('AUDIT', 'every step is in one tamper-evident chain');
  // The owner asks the server to sign the chain head, then verifies against
  // the out-of-band public key (which an attacker who rewrites the DB lacks).
  await request({
    method: 'POST',
    path: '/v1/audit/checkpoint',
    token: principalToken,
  });
  const verification = await request({
    method: 'GET',
    path: '/v1/audit/verify',
    token: principalToken,
  });
  if (!verification.body.ok) throw new Error(`Audit chain failed: ${JSON.stringify(verification.body)}`);
  good(`Chain verified to head seq ${verification.body.headSeq} (mode: ${verification.body.mode}).`);
  if (verification.body.mode !== 'checkpointed') {
    throw new Error(`Expected a signed checkpoint, got mode ${verification.body.mode}`);
  }
  line(`\n${C.bold}The agent worked ${cycle1.processed + cycle2.processed + cycle3.processed} email(s); the owner was surfaced exactly 2 decisions.${C.reset}`);
  void gateway;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
