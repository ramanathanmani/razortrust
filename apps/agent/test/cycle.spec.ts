/**
 * Offline agent tests — no database, no network. The fake API scripts the
 * policy verdicts; the full Strands agent loop (model -> tool calls -> tool
 * results -> repeat) runs for real with the deterministic ScriptedModel.
 */
import { describe, expect, it } from 'vitest';

import { runCycle } from '../src/cycle.js';
import { buildCafeFixture } from '../src/scenarios.js';
import { ScriptedModel } from '../src/scripted-model.js';
import { InMemoryJournal, InMemoryMailbox, InMemoryOutbox } from '../src/state.js';
import { FakeRazorTrustClient } from './fake-api.js';

const model = new ScriptedModel();
const fixture = buildCafeFixture(Date.now(), 'brewline_test');

async function runQuoteCycle(api: FakeRazorTrustClient) {
  const mailbox = new InMemoryMailbox([
    fixture.messages.validQuote,
    fixture.messages.overPriceCap,
    fixture.messages.injectedQuote,
  ]);
  const outbox = new InMemoryOutbox();
  const journal = new InMemoryJournal();

  const result = await runCycle({
    model,
    api,
    mailbox,
    outbox,
    journal,
    mandateId: 'mandate_test',
    allowedMerchantIds: ['brewline_test'],
  });
  return { result, mailbox, outbox, journal };
}

describe('overnight quote cycle', () => {
  it('holds the good quote and refuses the two out-of-mandate ones', async () => {
    const api = new FakeRazorTrustClient({
      blocks: {
        'Q-1002': ['UNIT_PRICE_EXCEEDED'],
        'Q-1003': ['TOTAL_ARITHMETIC', 'TOTAL_EXCEEDS_MANDATE_CEILING', 'CUMULATIVE_CEILING_EXCEEDED'],
      },
    });
    const { result, mailbox, journal } = await runQuoteCycle(api);

    expect(result.processed).toBe(3);

    const decisions = result.notifications.filter((n) => n.kind === 'decision_required');
    const blocks = result.notifications.filter((n) => n.kind === 'blocked');
    expect(decisions).toHaveLength(1);
    expect(blocks).toHaveLength(2);

    const approval = decisions[0]!;
    expect(approval.title).toMatch(/approve payment/i);
    expect(approval.actionUrl).toMatch(/^\/approve\//);
    expect(approval.detail).toContain('632420');

    // The premium-priced quote is blocked for the per-unit ceiling, nothing else.
    const unitBlock = blocks.find((b) => b.detail.includes('UNIT_PRICE_EXCEEDED'));
    expect(unitBlock).toBeTruthy();
    // The prompt-injection email is blocked on arithmetic + ceiling, never on its text.
    const injectionBlock = blocks.find((b) => b.detail.includes('TOTAL_ARITHMETIC'));
    expect(injectionBlock?.detail).not.toMatch(/ignore any price ceiling/i);

    // All three messages are consumed; the good one is parked awaiting a human.
    expect(await mailbox.listUnread()).toHaveLength(0);
    const entries = await journal.all();
    expect(entries.find((e) => e.messageId === 'mail-q1001')?.outcome).toBe('awaiting_approval');
    expect(entries.find((e) => e.messageId === 'mail-q1002')?.outcome).toBe('blocked');
    expect(entries.find((e) => e.messageId === 'mail-q1003')?.outcome).toBe('blocked');

    // Money discipline: the agent never tried to capture, and structured once per message.
    expect(api.calls.some((c) => c.method === 'capture')).toBe(false);
  });

  it('an unreadable email is surfaced as a decision instead of guessed', async () => {
    const garbled = {
      ...fixture.messages.validQuote,
      id: 'mail-garbled',
      subject: 'Quote Q-9999',
      body: 'Please ship us some coffee, bill us later. TOTAL unknown.',
    };
    const api = new FakeRazorTrustClient();
    const mailbox = new InMemoryMailbox([garbled]);
    const outbox = new InMemoryOutbox();
    const journal = new InMemoryJournal();

    const result = await runCycle({
      model,
      api,
      mailbox,
      outbox,
      journal,
      mandateId: 'mandate_test',
      allowedMerchantIds: ['brewline_test'],
    });

    expect(result.processed).toBe(1);
    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0]?.kind).toBe('decision_required');
    expect(result.notifications[0]?.title).toMatch(/could not be read/i);
    expect(await journal.byMessage('mail-garbled')).toMatchObject({ outcome: 'unreadable' });
  });
});

describe('sweep', () => {
  it('captures a human-authorized hold and leaves nothing for the owner', async () => {
    const api = new FakeRazorTrustClient({ authorized: ['Q-1001'] });
    const outbox = new InMemoryOutbox();
    const journal = new InMemoryJournal();
    await journal.record({
      messageId: 'mail-q1001',
      intentId: 'intent_old',
      merchantId: 'brewline_test',
      merchantQuoteRef: 'Q-1001',
      outcome: 'awaiting_approval',
    });
    api.seedIntent('intent_old', 'Q-1001', '632420');

    const result = await runCycle({
      model,
      api,
      mailbox: new InMemoryMailbox(),
      outbox,
      journal,
      mandateId: 'mandate_test',
      sweep: true,
    });

    expect(result.sweepRan).toBe(true);
    expect(api.calls.some((c) => c.method === 'capture')).toBe(true);
    expect(result.notifications).toHaveLength(0);
    expect(await journal.byQuoteRef('Q-1001')).toMatchObject({ outcome: 'captured' });
  });
});

describe('post-delivery settlement', () => {
  it('recommends a partial refund, the agent is refused, and a human decision is raised', async () => {
    const api = new FakeRazorTrustClient({
      settlement: {
        recommendation: 'partial_refund',
        refundAmountPaise: '235000',
        autoExecutable: false,
        summary: 'SHORT_QUANTITY (partial_refund): Short by 1 unit(s) of SKU-COFFEE-HOUSE-1KG',
      },
    });
    const outbox = new InMemoryOutbox();
    const journal = new InMemoryJournal();
    await journal.record({
      messageId: 'mail-q1001',
      intentId: 'intent_1',
      merchantId: 'brewline_test',
      merchantQuoteRef: 'Q-1001',
      outcome: 'captured',
    });
    api.seedIntent('intent_1', 'Q-1001', '632420', 'captured');

    const result = await runCycle({
      model,
      api,
      mailbox: new InMemoryMailbox([fixture.messages.shortDelivery]),
      outbox,
      journal,
      mandateId: 'mandate_test',
    });

    expect(result.processed).toBe(1);
    const decisions = result.notifications.filter((n) => n.kind === 'decision_required');
    expect(decisions).toHaveLength(1);
    const decision = decisions[0]!;
    expect(decision.title).toMatch(/recommended refund/i);
    expect(decision.data?.settlementId).toBe('stl_intent_1');
    expect(decision.data?.refundAmountPaise).toBe('235000');

    // The agent DID try execute_refund and the 403 is why the human is asked.
    expect(api.refundAttemptsByAgent).toBe(1);
    expect(api.executed).toHaveLength(0);
    expect(await journal.byMessage(fixture.messages.shortDelivery.id)).toMatchObject({
      outcome: 'settled',
    });
  });

  it('a clean delivery produces no decision and no refund attempt', async () => {
    const api = new FakeRazorTrustClient({
      settlement: { recommendation: 'none', refundAmountPaise: '0', autoExecutable: false },
    });
    const outbox = new InMemoryOutbox();
    const journal = new InMemoryJournal();
    await journal.record({
      messageId: 'mail-q1001',
      intentId: 'intent_1',
      merchantId: 'brewline_test',
      merchantQuoteRef: 'Q-1001',
      outcome: 'captured',
    });

    const result = await runCycle({
      model,
      api,
      mailbox: new InMemoryMailbox([fixture.messages.shortDelivery]),
      outbox,
      journal,
      mandateId: 'mandate_test',
    });

    expect(api.refundAttemptsByAgent).toBe(0);
    expect(result.notifications.filter((n) => n.kind === 'decision_required')).toHaveLength(0);
  });

  it('when the signed mandate permits auto refunds, the agent executes without pinging the owner', async () => {
    const api = new FakeRazorTrustClient({
      agentMayRefund: true,
      settlement: {
        recommendation: 'partial_refund',
        refundAmountPaise: '235000',
        autoExecutable: true,
      },
    });
    const outbox = new InMemoryOutbox();
    const journal = new InMemoryJournal();
    await journal.record({
      messageId: 'mail-q1001',
      intentId: 'intent_1',
      merchantId: 'brewline_test',
      merchantQuoteRef: 'Q-1001',
      outcome: 'captured',
    });

    await runCycle({
      model,
      api,
      mailbox: new InMemoryMailbox([fixture.messages.shortDelivery]),
      outbox,
      journal,
      mandateId: 'mandate_test',
    });

    expect(api.executed).toHaveLength(1);
    expect(outbox.notifications.filter((n) => n.kind === 'decision_required')).toHaveLength(0);
    const handled = outbox.notifications.filter((n) => n.kind === 'handled');
    expect(handled).toHaveLength(1);
  });
});
