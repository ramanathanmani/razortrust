/**
 * The tools Steward can call.
 *
 * Each tool is a thin, honest wrapper around a real effect: an HTTP call to
 * RazorTrust, the mailbox, the journal, or the outbox. The LLM (or the
 * ScriptedModel standing in for one) chooses the ORDER and reads the RESULTS.
 * It cannot choose the verdict — there is no tool that approves a payment, no
 * tool that edits a mandate, and no tool that holds a card.
 */
import { tool } from '@strands-agents/sdk';
import { z } from 'zod';

import { parseDeliveryNote } from './delivery-parser.js';
import type {
  Journal,
  JournalEntry,
  MailMessage,
  Mailbox,
  Outbox,
  RazorTrustClient,
} from './types.js';
import type { InvokableTool } from '@strands-agents/sdk';

export interface ToolDeps {
  api: RazorTrustClient;
  mailbox: Mailbox;
  outbox: Outbox;
  journal: Journal;
  messages: Map<string, MailMessage>;
  mandateId: string;
}

/** Pull a human-readable rule summary out of a drift-block response. */
function violationSummary(body: any): string {
  const violations = body?.detail?.violations ?? body?.detail?.failures;
  if (Array.isArray(violations) && violations.length > 0) {
    return violations
      .map((v: any) => (v.ruleId ? `${v.ruleId}: ${v.message ?? ''}`.trim() : v.message ?? String(v)))
      .join('; ');
  }
  return body?.message ?? 'the request was refused';
}

export function buildTools(deps: ToolDeps): InvokableTool<any, any>[] {
  const { api, mailbox, outbox, journal, messages, mandateId } = deps;

  const openIntent = tool({
    name: 'open_intent',
    description:
      'Open a purchase intent for one quote email, against the configured signed mandate. No money moves.',
    inputSchema: z.object({
      messageId: z.string().describe('The mailbox message id of the quote email'),
      merchantId: z.string().describe('The merchant external reference the message came from'),
    }),
    callback: async ({ messageId, merchantId }) => {
      const message = messages.get(messageId);
      if (!message) return { ok: false, message: `Unknown message ${messageId}` };
      if (message.kind !== 'quote') return { ok: false, message: 'Message is not a quote' };

      const res = await api.createIntent({ mandateId, merchantId });
      if (!res.ok) return { ok: false, message: violationSummary(res.body) };
      return { ok: true, intentId: res.body.intentId, state: res.body.state };
    },
  });

  const structureQuote = tool({
    name: 'structure_quote',
    description:
      'Turn the raw quote email into a structured, grounded quote and attach it to the intent. ' +
      'Every figure must cite verbatim text; an unreadable quote is rejected, never guessed.',
    inputSchema: z.object({
      messageId: z.string(),
      intentId: z.string(),
    }),
    callback: async ({ messageId, intentId }) => {
      const message = messages.get(messageId);
      if (!message) return { ok: false, message: `Unknown message ${messageId}` };

      const res = await api.structureFromText(intentId, message.body);
      if (!res.ok) {
        return {
          ok: false,
          code: res.body?.detail?.code ?? res.body?.error,
          message: res.body?.detail?.reason ?? res.body?.message ?? 'the quote could not be structured',
        };
      }
      await journal.record({
        messageId,
        intentId,
        merchantId: message.merchantId,
        merchantQuoteRef: res.body.structuredQuote?.merchantQuoteRef ?? undefined,
        outcome: 'quoted',
      });
      return {
        ok: true,
        intentId,
        quoteRef: res.body.structuredQuote?.merchantQuoteRef ?? null,
        totalPaise: res.body.totalPaise,
        model: res.body.model,
      };
    },
  });

  const checkQuote = tool({
    name: 'check_quote',
    description:
      'Ask RazorTrust for the deterministic verdict: does this quote match the signed mandate? ' +
      'This is an immutable policy decision, not the model’s opinion.',
    inputSchema: z.object({ intentId: z.string() }),
    callback: async ({ intentId }) => {
      const res = await api.checkQuote(intentId);
      if (!res.ok) {
        return { decision: 'block', ok: false, summary: violationSummary(res.body) };
      }
      return { decision: 'allow', ok: true, quoteHash: res.body.quoteHash, rulesVersion: res.body.rulesVersion };
    },
  });

  const requestAuthorization = tool({
    name: 'request_authorization',
    description:
      'Place a manual-capture authorization HOLD for an allowed quote. Returns a one-time, ' +
      'expiring approval link that only the human can complete. The agent holds no instrument.',
    inputSchema: z.object({ intentId: z.string() }),
    callback: async ({ intentId }) => {
      const res = await api.authorize(intentId);
      if (!res.ok) return { ok: false, message: violationSummary(res.body) };

      const entry = (await journal.all()).find((e) => e.intentId === intentId);
      if (entry) {
        await journal.record({ ...entry, outcome: 'awaiting_approval' });
      }
      return {
        ok: true,
        intentId,
        state: res.body.state,
        amountPaise: res.body.amountPaise,
        currency: res.body.currency,
        approvalUrl: res.body.approvalUrl,
        approvalExpiresAt: res.body.approvalExpiresAt,
      };
    },
  });

  const listOrders = tool({
    name: 'list_orders',
    description:
      'List purchase intents this agent has opened and their latest state. Use during a sweep ' +
      'to find holds a human has approved that are ready to capture.',
    inputSchema: z.object({}),
    callback: async () => {
      const entries = await journal.all();
      const orders = [];
      for (const entry of entries) {
        if (entry.outcome !== 'awaiting_approval' && entry.outcome !== 'captured') continue;
        const res = await api.getIntent(entry.intentId);
        if (res.ok) {
          orders.push({
            intentId: entry.intentId,
            state: res.body.state,
            merchantQuoteRef: entry.merchantQuoteRef ?? null,
            authorizedAmountPaise: res.body.authorizedAmountPaise,
          });
        }
      }
      return { ok: true, orders };
    },
  });

  const capturePayment = tool({
    name: 'capture_payment',
    description:
      'Capture an EXISTING, human-approved hold (the person completed checkout). RazorTrust ' +
      're-verifies the mandate and re-runs every drift rule before money moves.',
    inputSchema: z.object({ intentId: z.string() }),
    callback: async ({ intentId }) => {
      const res = await api.capture(intentId);
      if (!res.ok) return { ok: false, message: violationSummary(res.body) };
      const entry = (await journal.all()).find((e) => e.intentId === intentId);
      if (entry) await journal.record({ ...entry, outcome: 'captured' });
      return { ok: true, intentId, state: res.body.state, capturedAmountPaise: res.body.capturedAmountPaise };
    },
  });

  const resolveDelivery = tool({
    name: 'resolve_delivery',
    description:
      'Parse a carrier delivery note and match it to a purchase by its merchant quote reference.',
    inputSchema: z.object({ messageId: z.string() }),
    callback: async ({ messageId }) => {
      const message = messages.get(messageId);
      if (!message) return { ok: false, message: `Unknown message ${messageId}` };
      const parsed = parseDeliveryNote(message.body);
      if (!parsed) return { ok: false, message: 'Could not parse the delivery note or find a quote ref' };

      const entry = await journal.byQuoteRef(parsed.quoteRef);
      if (!entry) {
        return { ok: false, message: `No known purchase matches quote ${parsed.quoteRef}` };
      }
      return { ok: true, intentId: entry.intentId, quoteRef: parsed.quoteRef, evidence: parsed.evidence };
    },
  });

  const recordDelivery = tool({
    name: 'record_delivery',
    description: 'Record what actually arrived. Bookkeeping only; it moves and pays nothing.',
    inputSchema: z.object({ messageId: z.string(), intentId: z.string() }),
    callback: async ({ messageId, intentId }) => {
      const message = messages.get(messageId);
      if (!message) return { ok: false, message: `Unknown message ${messageId}` };
      const parsed = parseDeliveryNote(message.body);
      if (!parsed) return { ok: false, message: 'Could not parse the delivery note' };

      const res = await api.recordDelivery(intentId, parsed.evidence, 'merchant_api');
      if (!res.ok) return { ok: false, message: violationSummary(res.body) };
      return { ok: true, deliveryId: res.body.deliveryId, status: res.body.status };
    },
  });

  const settleDelivery = tool({
    name: 'settle_delivery',
    description:
      'Run the settlement rules. Produces a RECOMMENDATION (none / partial / full refund / escalate); ' +
      'it never moves money by itself.',
    inputSchema: z.object({ intentId: z.string() }),
    callback: async ({ intentId }) => {
      const res = await api.settle(intentId);
      if (!res.ok) return { ok: false, message: violationSummary(res.body) };
      return {
        ok: true,
        settlementId: res.body.settlementId,
        recommendation: res.body.recommendation,
        refundAmountPaise: res.body.refundAmountPaise,
        autoExecutable: res.body.autoExecutable,
        summary: res.body.summary,
      };
    },
  });

  const executeRefund = tool({
    name: 'execute_refund',
    description:
      'Execute a recommended refund. Allowed for the agent only when the signed mandate set ' +
      'autoRefundAllowed; otherwise the API refuses and a human must approve it.',
    inputSchema: z.object({
      intentId: z.string(),
      settlementId: z.string(),
      amountPaise: z.string().describe('Must match the recommended amount exactly, in paise.'),
    }),
    callback: async ({ settlementId, amountPaise }) => {
      const res = await api.executeRefund(settlementId, amountPaise);
      if (!res.ok) {
        return {
          ok: false,
          forbidden: res.status === 403,
          code: res.body?.error,
          message: res.body?.message ?? 'the refund was refused',
        };
      }
      return {
        ok: true,
        refundId: res.body.refundId,
        kind: res.body.kind,
        amountPaise: res.body.amountPaise,
        state: res.body.state,
      };
    },
  });

  const notifyOwner = tool({
    name: 'notify_owner',
    description:
      'Surface something to the human: a required decision, a blocked attempt, or a handled item. ' +
      'This is the ONLY way the agent raises its hand.',
    inputSchema: z.object({
      kind: z.enum(['decision_required', 'blocked', 'handled']),
      title: z.string(),
      detail: z.string(),
      actionUrl: z.string().optional(),
      intentId: z.string().optional(),
      messageId: z.string().optional(),
      data: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Structured handles (ids, amounts) the human console needs to act on the decision.'),
    }),
    callback: async ({ kind, title, detail, actionUrl, intentId, messageId, data }) => {
      await outbox.append({
        kind,
        title,
        detail,
        ...(actionUrl ? { actionUrl } : {}),
        ...(intentId ? { intentId } : {}),
        ...(messageId ? { messageId } : {}),
        ...(data ? { data } : {}),
      });
      return { ok: true, delivered: true };
    },
  });

  const markHandled = tool({
    name: 'mark_handled',
    description: 'Mark a mailbox message processed with the final outcome, so it is never reworked.',
    inputSchema: z.object({
      messageId: z.string(),
      outcome: z.enum(['awaiting_approval', 'blocked', 'unreadable', 'settled']),
      intentId: z.string().optional(),
    }),
    callback: async ({ messageId, outcome, intentId }) => {
      await mailbox.markProcessed(messageId);
      const existing = await journal.byMessage(messageId);
      if (existing) {
        await journal.record({ ...existing, outcome });
      } else {
        // An unreadable message never opened an intent; still keep its
        // outcome in the journal so the human console shows why it stopped.
        const message = messages.get(messageId);
        await journal.record({
          messageId,
          intentId: intentId ?? '',
          merchantId: message?.merchantId ?? 'unknown',
          outcome: outcome as JournalEntry['outcome'],
        });
      }
      return { ok: true, messageId, outcome };
    },
  });

  return [
    openIntent,
    structureQuote,
    checkQuote,
    requestAuthorization,
    listOrders,
    capturePayment,
    resolveDelivery,
    recordDelivery,
    settleDelivery,
    executeRefund,
    notifyOwner,
    markHandled,
  ];
}
