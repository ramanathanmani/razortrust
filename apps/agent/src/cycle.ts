/**
 * One background cycle: work every unread mailbox message, then sweep holds a
 * human has approved since the last cycle. Designed to run on a timer in
 * production (`--watch`) and once per invocation in demos and tests.
 *
 * Each task gets a FRESH Strands agent — a new conversation — while sharing
 * the same tools, journal and outbox. Steward's durable memory is the
 * RazorTrust API plus its journal, not an LLM context window.
 */
import { Message, type Model } from '@strands-agents/sdk';

import { createStewardAgent } from './agent.js';
import type {
  Journal,
  MailMessage,
  Mailbox,
  Notification,
  Outbox,
  RazorTrustClient,
} from './types.js';

export interface CycleDeps {
  model: Model;
  api: RazorTrustClient;
  mailbox: Mailbox;
  outbox: Outbox;
  journal: Journal;
  mandateId: string;
  /** Merchants Steward is configured to handle; undefined = all in the mailbox. */
  allowedMerchantIds?: string[];
  /** Run the capture sweep after processing mail. */
  sweep?: boolean;
  /** Hard ceiling on agentic turns per task — a runaway loop must not spin forever. */
  maxTurns?: number;
  agentName?: string;
}

export interface CycleResult {
  processed: number;
  sweepRan: boolean;
  notifications: Notification[];
}

/** Plain-text rendering of an assistant Message (tool blocks are summarised). */
export function messageText(message: unknown): string {
  const content = (message as Message | undefined)?.content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const anyBlock = block as { type?: string; text?: string; name?: string };
      if (typeof anyBlock.text === 'string') return anyBlock.text;
      if (anyBlock.type === 'toolUseBlock') return `[tool:${anyBlock.name}]`;
      return '';
    })
    .join(' ')
    .trim();
}

export async function runCycle(deps: CycleDeps): Promise<CycleResult> {
  const messages = new Map<string, MailMessage>();
  const unread = await deps.mailbox.listUnread(deps.allowedMerchantIds);
  for (const message of unread) messages.set(message.id, message);

  const notificationsAtStart = (await deps.outbox.list()).length;
  let processed = 0;

  for (const message of [...unread].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))) {
    const agent = createStewardAgent({
      model: deps.model,
      api: deps.api,
      mailbox: deps.mailbox,
      outbox: deps.outbox,
      journal: deps.journal,
      messages,
      mandateId: deps.mandateId,
      ...(deps.agentName ? { name: deps.agentName } : {}),
    });

    const brief = JSON.stringify({
      task: 'process_message',
      messageId: message.id,
      merchantId: message.merchantId,
      kind: message.kind,
    });

    const result = await agent.invoke(brief, { limits: { turns: deps.maxTurns ?? 24 } });
    const finalText = messageText(result?.lastMessage);
    if (!result?.lastMessage || (!finalText && result.stopReason !== 'toolUse')) {
      // Even an odd model ending must not kill the cycle.
      await deps.outbox.append({
        kind: 'blocked',
        title: `Agent cycle ended unexpectedly for message ${message.id}`,
        detail: 'The agent produced no final message; the message was left unread for review.',
        messageId: message.id,
      });
    } else {
      processed += 1;
    }
  }

  let sweepRan = false;
  if (deps.sweep) {
    const sweeper = createStewardAgent({
      model: deps.model,
      api: deps.api,
      mailbox: deps.mailbox,
      outbox: deps.outbox,
      journal: deps.journal,
      messages,
      mandateId: deps.mandateId,
      name: 'steward-sweep',
    });
    await sweeper.invoke(JSON.stringify({ task: 'sweep' }), { limits: { turns: deps.maxTurns ?? 24 } });
    sweepRan = true;
  }

  return {
    processed,
    sweepRan,
    notifications: (await deps.outbox.list()).slice(notificationsAtStart),
  };
}

/** Human-readable digest: what was handled silently, and what needs a person. */
export function formatDigest(result: CycleResult): string {
  const decisions = result.notifications.filter((n) => n.kind === 'decision_required');
  const blocks = result.notifications.filter((n) => n.kind === 'blocked');
  const handled = result.notifications.filter((n) => n.kind === 'handled');

  const lines: string[] = [];
  lines.push(`Cycle complete: ${result.processed} message(s) processed${result.sweepRan ? ', sweep ran' : ''}.`);
  if (decisions.length > 0) {
    lines.push(`\n${decisions.length} decision(s) for you:`);
    for (const n of decisions) lines.push(`  ! ${n.title} — ${n.detail}`);
  }
  if (blocks.length > 0) {
    lines.push(`\n${blocks.length} attempt(s) blocked by the mandate:`);
    for (const n of blocks) lines.push(`  x ${n.title} — ${n.detail}`);
  }
  if (handled.length > 0) {
    lines.push(`\n${handled.length} item(s) handled autonomously:`);
    for (const n of handled) lines.push(`  - ${n.title}`);
  }
  if (result.notifications.length === 0) lines.push('Nothing needed attention.');
  return lines.join('\n');
}
