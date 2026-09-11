/**
 * Steward's world-facing types.
 *
 * The agent talks to three things: the RazorTrust HTTP API (money decisions),
 * a mailbox (merchant emails), and an outbox (the only way it can surface
 * something to its owner). Nothing here decides anything about money — every
 * answer of consequence comes back from the API, signed and drift-checked.
 */

export type MailKind = 'quote' | 'delivery';

export interface MailMessage {
  id: string;
  receivedAt: string;
  kind: MailKind;
  from: string;
  subject: string;
  body: string;
  /** Merchant external ref, set when the message is routed into a tenant. */
  merchantId: string;
}

export type NotificationKind =
  /** A human decision is required: approve a hold, approve a refund, review an escalation. */
  | 'decision_required'
  /** The agent tried and a deterministic control refused it. */
  | 'blocked'
  /** Routine autonomy — recorded so the owner can see what was handled. */
  | 'handled';

export interface Notification {
  id: string;
  createdAt: string;
  kind: NotificationKind;
  title: string;
  detail: string;
  messageId?: string;
  intentId?: string;
  actionUrl?: string;
  data?: Record<string, unknown>;
}

export interface JournalEntry {
  messageId: string;
  intentId: string;
  merchantId: string;
  merchantQuoteRef?: string;
  outcome:
    | 'quoted'
    | 'awaiting_approval'
    | 'blocked'
    | 'unreadable'
    | 'captured'
    | 'settled';
}

/** Everything an API response gives the agent. */
export interface ApiResult<T = any> {
  status: number;
  ok: boolean;
  body: T;
}

/** The subset of the RazorTrust API Steward calls. Two implementations: HTTP and in-process. */
export interface RazorTrustClient {
  createIntent(args: { mandateId: string; merchantId: string }): Promise<ApiResult>;
  structureFromText(intentId: string, rawInput: string): Promise<ApiResult>;
  checkQuote(intentId: string): Promise<ApiResult>;
  authorize(intentId: string): Promise<ApiResult>;
  capture(intentId: string): Promise<ApiResult>;
  getIntent(intentId: string): Promise<ApiResult>;
  recordDelivery(
    intentId: string,
    evidence: unknown,
    source: 'merchant_api' | 'ai_structured',
  ): Promise<ApiResult>;
  settle(intentId: string): Promise<ApiResult>;
  executeRefund(settlementId: string, amountPaise: string): Promise<ApiResult>;
}

export interface Mailbox {
  listUnread(merchantIds?: string[]): Promise<MailMessage[]>;
  markProcessed(messageId: string, outcome?: string): Promise<void>;
}

export interface Outbox {
  append(n: Omit<Notification, 'id' | 'createdAt'> & { createdAt?: string }): Promise<Notification>;
  list(): Promise<Notification[]>;
}

export interface Journal {
  record(entry: JournalEntry): Promise<void>;
  byQuoteRef(ref: string): Promise<JournalEntry | undefined>;
  byMessage(messageId: string): Promise<JournalEntry | undefined>;
  all(): Promise<JournalEntry[]>;
}
