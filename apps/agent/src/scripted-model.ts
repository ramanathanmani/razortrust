/**
 * ScriptedModel — a deterministic stand-in for the Bedrock-backed brain.
 *
 * It implements the same Strands `Model` contract, so the ENTIRE Strands agent
 * loop runs for real — task prompt, tool selection, tool execution, tool
 * results fed back, repeat. What is scripted is only the "which tool next"
 * decision a foundation model would make, expressed as an explicit, auditable
 * procedure. That makes the product runnable end to end with zero API credits
 * (demos, CI, a laptop on a plane), while the production swap is one line:
 * `new BedrockModel(...)`.
 *
 * Note the boundary this preserves: the script decides HOW TO WORK a purchase
 * request, never whether it may be paid. Every allow/block answer still comes
 * from RazorTrust's deterministic engine over a signed mandate.
 */
import { Model, type BaseModelConfig, type Message, type ModelStreamEvent } from '@strands-agents/sdk';

interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

interface ToolTurn {
  call: ToolCall;
  status: 'success' | 'error';
  result: any;
}

interface TaskBrief {
  task: 'process_message' | 'sweep';
  messageId?: string;
  merchantId?: string;
  kind?: 'quote' | 'delivery';
}

/** Pull the task brief out of the first user message. */
function readTask(messages: Message[]): TaskBrief | null {
  for (const message of messages) {
    if (message.role !== 'user') continue;
    for (const block of message.content) {
      if (block.type === 'textBlock' && 'text' in block) {
        try {
          const parsed = JSON.parse((block as { text: string }).text);
          if (parsed && typeof parsed.task === 'string') return parsed as TaskBrief;
        } catch {
          /* Not every user message is a brief. */
        }
      }
    }
  }
  return null;
}

function resultText(content: any[]): string {
  return content
    .map((item) => {
      if (item?.type === 'textBlock' || item?.type === 'text') return item.text;
      if (item?.json !== undefined) return JSON.stringify(item.json);
      if (typeof item === 'string') return item;
      return JSON.stringify(item);
    })
    .join('\n');
}

/** Walk the conversation and recover the tool calls/results so far. */
function readTurns(messages: Message[]): ToolTurn[] {
  const calls = new Map<string, ToolCall>();
  const turns: ToolTurn[] = [];

  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'toolUseBlock') {
        const b = block as unknown as { toolUseId: string; name: string; input: unknown };
        calls.set(b.toolUseId, { name: b.name, input: (b.input as Record<string, unknown>) ?? {} });
      } else if (block.type === 'toolResultBlock') {
        const b = block as unknown as {
          toolUseId: string;
          status: 'success' | 'error';
          content: any[];
        };
        const call = calls.get(b.toolUseId);
        if (!call) continue;
        let parsed: any = {};
        const text = resultText(b.content);
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { raw: text };
        }
        turns.push({ call, status: b.status, result: parsed });
      }
    }
  }
  return turns;
}

function resultFor(turns: ToolTurn[], toolName: string): any | undefined {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i]?.call.name === toolName) return turns[i]?.result;
  }
  return undefined;
}

function called(turns: ToolTurn[], toolName: string): boolean {
  return turns.some((t) => t.call.name === toolName);
}

/**
 * The procedure. Same shape as the operating procedure the system prompt
 * gives the Bedrock model — deterministic, inspectable, and small.
 */
export function planNextAction(task: TaskBrief, turns: ToolTurn[]): ToolCall | { text: string } {
  const say = (text: string) => ({ text });

  if (task.task === 'sweep') {
    if (!called(turns, 'list_orders')) return { name: 'list_orders', input: {} };
    const list = resultFor(turns, 'list_orders');
    const ready: Array<{ intentId: string }> = (list?.orders ?? []).filter(
      (o: { state: string }) => o.state === 'authorized',
    );
    const attempted = turns.filter((t) => t.call.name === 'capture_payment').length;
    const next = ready[attempted];
    if (next) return { name: 'capture_payment', input: { intentId: next.intentId } };
    if (ready.length === 0) return say('Sweep: no approved holds waiting to capture.');
    return say(`Sweep: captured ${ready.length} approved hold(s).`);
  }

  const { messageId, merchantId, kind } = task;
  if (!messageId || !merchantId || !kind) return say('Malformed task brief.');
  const fail = (notification: { title: string; detail: string; kind: string }, outcome: string) => {
    if (!called(turns, 'notify_owner')) {
      return {
        name: 'notify_owner',
        input: {
          kind: notification.kind,
          title: notification.title,
          detail: notification.detail,
          messageId,
        },
      };
    }
    if (!called(turns, 'mark_handled')) {
      return { name: 'mark_handled', input: { messageId, outcome } };
    }
    return say(notification.title);
  };

  if (kind === 'quote') {
    // 1. Open an intent against the mandate named in our configuration.
    if (!called(turns, 'open_intent')) {
      return { name: 'open_intent', input: { messageId, merchantId } };
    }
    const opened = resultFor(turns, 'open_intent');
    if (!opened?.ok) {
      return fail(
        { kind: 'blocked', title: 'Could not open a purchase intent', detail: opened?.message ?? 'unknown error' },
        'unreadable',
      );
    }
    const intentId = opened.intentId as string;

    // 2. Structure the email. Abstention / grounding failure is a block, not a guess.
    if (!called(turns, 'structure_quote')) {
      return { name: 'structure_quote', input: { messageId, intentId } };
    }
    const structured = resultFor(turns, 'structure_quote');
    if (!structured?.ok) {
      return fail(
        {
          kind: 'decision_required',
          title: 'A quote email could not be read safely',
          detail: structured?.message ?? 'structuring rejected; no quote was created',
        },
        'unreadable',
      );
    }

    // 3. The deterministic verdict.
    if (!called(turns, 'check_quote')) {
      return { name: 'check_quote', input: { intentId } };
    }
    const verdict = resultFor(turns, 'check_quote');
    if (verdict?.decision !== 'allow') {
      return fail(
        {
          kind: 'blocked',
          title: 'A purchase was blocked against the signed mandate',
          detail: verdict?.summary ?? 'the drift engine refused this quote',
        },
        'blocked',
      );
    }

    // 4. Place the authorization HOLD. This hands the human a one-time link;
    //    the agent cannot complete checkout.
    if (!called(turns, 'request_authorization')) {
      return { name: 'request_authorization', input: { intentId } };
    }
    const held = resultFor(turns, 'request_authorization');
    if (!held?.ok) {
      return fail(
        { kind: 'blocked', title: 'The payment hold was refused', detail: held?.message ?? 'unknown error' },
        'blocked',
      );
    }
    if (!called(turns, 'notify_owner')) {
      return {
        name: 'notify_owner',
        input: {
          kind: 'decision_required',
          title: 'Approve payment (one-time link, expires)',
          detail: `Quote ${structured.quoteRef ?? ''} for ${held.amountPaise} paise passed every rule. ` +
            `Complete checkout here: ${held.approvalUrl}`,
          actionUrl: held.approvalUrl,
          intentId,
          messageId,
        },
      };
    }
    if (!called(turns, 'mark_handled')) {
      return { name: 'mark_handled', input: { messageId, outcome: 'awaiting_approval', intentId } };
    }
    return say('Hold placed; the owner has the one-time approval link.');
  }

  // Delivery: evidence -> settlement recommendation -> human-gated refund.
  if (!called(turns, 'resolve_delivery')) {
    return { name: 'resolve_delivery', input: { messageId } };
  }
  const resolved = resultFor(turns, 'resolve_delivery');
  if (!resolved?.ok) {
    return fail(
      {
        kind: 'decision_required',
        title: 'A delivery note could not be matched to an order',
        detail: resolved?.message ?? 'could not parse or match the delivery note',
      },
      'unreadable',
    );
  }
  const intentId = resolved.intentId as string;

  if (!called(turns, 'record_delivery')) {
    return { name: 'record_delivery', input: { messageId, intentId } };
  }
  const recorded = resultFor(turns, 'record_delivery');
  if (!recorded?.ok) {
    return fail({ kind: 'blocked', title: 'Delivery evidence rejected', detail: recorded?.message ?? '' }, 'unreadable');
  }

  if (!called(turns, 'settle_delivery')) {
    return { name: 'settle_delivery', input: { intentId } };
  }
  const settlement = resultFor(turns, 'settle_delivery');
  if (!settlement?.ok) {
    return fail({ kind: 'blocked', title: 'Settlement failed', detail: settlement?.message ?? '' }, 'unreadable');
  }

  if (settlement.recommendation === 'none') {
    if (!called(turns, 'notify_owner')) {
      return {
        name: 'notify_owner',
        input: {
          kind: 'handled',
          title: 'Delivery settled — nothing owed',
          detail: settlement.summary ?? 'The delivery matched the order.',
          intentId,
          messageId,
        },
      };
    }
    if (!called(turns, 'mark_handled')) {
      return { name: 'mark_handled', input: { messageId, outcome: 'settled', intentId } };
    }
    return say('Delivery matched; no refund needed.');
  }

  if (settlement.recommendation === 'escalate') {
    if (!called(turns, 'notify_owner')) {
      return {
        name: 'notify_owner',
        input: {
          kind: 'decision_required',
          title: 'Delivery needs your judgement (escalated)',
          detail: settlement.summary ?? 'Evidence is contradictory; the engine carried no amount.',
          intentId,
          messageId,
        },
      };
    }
    if (!called(turns, 'mark_handled')) {
      return { name: 'mark_handled', input: { messageId, outcome: 'settled', intentId } };
    }
    return say('Escalated to the owner; no amount was computed.');
  }

  // A refund was recommended. Try autonomy first — the signed mandate says
  // whether that is permitted. A refusal here is expected and correct.
  if (!called(turns, 'execute_refund')) {
    return {
      name: 'execute_refund',
      input: { intentId, settlementId: settlement.settlementId, amountPaise: settlement.refundAmountPaise },
    };
  }
  const executed = resultFor(turns, 'execute_refund');
  if (executed?.ok) {
    if (!called(turns, 'notify_owner')) {
      return {
        name: 'notify_owner',
        input: {
          kind: 'handled',
          title: 'Refund executed under your standing mandate',
          detail: `${executed.kind ?? ''} refund of ${executed.amountPaise} paise for ${intentId}.`,
          intentId,
          messageId,
        },
      };
    }
  } else if (!called(turns, 'notify_owner')) {
    return {
      name: 'notify_owner',
      input: {
        kind: 'decision_required',
        title: 'Approve the recommended refund',
        detail:
          `The settlement engine recommends a ${settlement.recommendation.replace('_', ' ')} of ` +
          `${settlement.refundAmountPaise} paise, but this mandate requires a human to approve it. ` +
          (executed?.message ? `(${executed.message}) ` : '') +
          `Open the console to confirm the exact amount.`,
        intentId,
        messageId,
        data: { settlementId: settlement.settlementId, refundAmountPaise: settlement.refundAmountPaise },
      },
    };
  }
  if (!called(turns, 'mark_handled')) {
    return { name: 'mark_handled', input: { messageId, outcome: 'settled', intentId } };
  }
  return say('Settlement handled.');
}

export class ScriptedModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'steward-scripted-1' };

  constructor() {
    super();
  }

  updateConfig(config: BaseModelConfig): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): BaseModelConfig {
    return this.config;
  }

  override async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    const task = readTask(messages);
    const turns = readTurns(messages);
    const next = task ? planNextAction(task, turns) : { text: 'No task brief was provided.' };

    yield { type: 'modelMessageStartEvent', role: 'assistant' };

    if ('text' in next) {
      yield { type: 'modelContentBlockStartEvent' };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: next.text } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
      return;
    }

    const toolUseId = `scripted_${turns.length + 1}_${next.name}`;
    yield {
      type: 'modelContentBlockStartEvent',
      start: { type: 'toolUseStart', name: next.name, toolUseId },
    };
    yield {
      type: 'modelContentBlockDeltaEvent',
      delta: { type: 'toolUseInputDelta', input: JSON.stringify(next.input) },
    };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
  }
}
