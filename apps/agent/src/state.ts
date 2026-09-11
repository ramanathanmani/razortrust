/**
 * Local agent state: the mailbox queue, the decision outbox, and a small
 * journal mapping merchant quote references to intents.
 *
 * File-backed for real runs (so `--watch` survives a restart), with in-memory
 * implementations used by tests. The state here holds no payment instrument
 * and no authority — it is a to-do list. The signed mandate in RazorTrust is
 * the authority; losing or editing these files can move no money.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type {
  Journal,
  JournalEntry,
  MailMessage,
  Mailbox,
  Notification,
  Outbox,
} from './types.js';

// --------------------------------------------------------------------------
// In-memory implementations (tests)
// --------------------------------------------------------------------------

export class InMemoryMailbox implements Mailbox {
  private readonly messages: MailMessage[];
  private readonly processed = new Set<string>();

  constructor(messages: MailMessage[] = []) {
    this.messages = [...messages];
  }

  add(message: MailMessage): void {
    this.messages.push(message);
  }

  async listUnread(merchantIds?: string[]): Promise<MailMessage[]> {
    return this.messages
      .filter((m) => !this.processed.has(m.id))
      .filter((m) => !merchantIds || merchantIds.includes(m.merchantId));
  }

  async markProcessed(messageId: string, _outcome?: string): Promise<void> {
    this.processed.add(messageId);
  }
}

export class InMemoryOutbox implements Outbox {
  readonly notifications: Notification[] = [];

  async append(n: Omit<Notification, 'id' | 'createdAt'> & { createdAt?: string }): Promise<Notification> {
    const notification: Notification = {
      id: randomUUID(),
      createdAt: n.createdAt ?? new Date().toISOString(),
      kind: n.kind,
      title: n.title,
      detail: n.detail,
      ...(n.messageId ? { messageId: n.messageId } : {}),
      ...(n.intentId ? { intentId: n.intentId } : {}),
      ...(n.actionUrl ? { actionUrl: n.actionUrl } : {}),
      ...(n.data ? { data: n.data } : {}),
    };
    this.notifications.push(notification);
    return notification;
  }

  async list(): Promise<Notification[]> {
    return [...this.notifications];
  }
}

export class InMemoryJournal implements Journal {
  private entries: JournalEntry[] = [];

  async record(entry: JournalEntry): Promise<void> {
    // One outcome per message; later outcomes overwrite (e.g. quoted -> captured).
    this.entries = this.entries.filter((e) => e.messageId !== entry.messageId);
    this.entries.push(entry);
  }

  async byQuoteRef(ref: string): Promise<JournalEntry | undefined> {
    return this.entries.find((e) => e.merchantQuoteRef === ref);
  }

  async byMessage(messageId: string): Promise<JournalEntry | undefined> {
    return this.entries.find((e) => e.messageId === messageId);
  }

  async all(): Promise<JournalEntry[]> {
    return [...this.entries];
  }
}

// --------------------------------------------------------------------------// File-backed implementations (real runs)
// --------------------------------------------------------------------------

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export class FileMailbox implements Mailbox {
  private readonly processedPath: string;
  private processed: Set<string>;

  constructor(private readonly dir: string) {
    this.processedPath = join(dir, 'processed.json');
    this.processed = new Set(readJson<string[]>(this.processedPath, []));
  }

  async listUnread(merchantIds?: string[]): Promise<MailMessage[]> {
    if (!existsSync(this.dir)) return [];
    const names = (await readdir(this.dir)).filter((n) => n.endsWith('.json'));
    const messages: MailMessage[] = [];
    for (const name of names.sort()) {
      if (name === 'outbox.json' || name === 'journal.json') continue;
      const message = readJson<MailMessage | null>(join(this.dir, name), null);
      if (message && !this.processed.has(message.id)) {
        if (!merchantIds || merchantIds.includes(message.merchantId)) messages.push(message);
      }
    }
    return messages.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  }

  async markProcessed(messageId: string, _outcome?: string): Promise<void> {
    this.processed.add(messageId);
    writeJson(this.processedPath, [...this.processed]);
  }
}

export class FileOutbox implements Outbox {
  private readonly path: string;

  constructor(dir: string) {
    this.path = join(dir, 'outbox.json');
  }

  async append(n: Omit<Notification, 'id' | 'createdAt'>): Promise<Notification> {
    const items = readJson<Notification[]>(this.path, []);
    const notification: Notification = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      kind: n.kind,
      title: n.title,
      detail: n.detail,
      ...(n.messageId ? { messageId: n.messageId } : {}),
      ...(n.intentId ? { intentId: n.intentId } : {}),
      ...(n.actionUrl ? { actionUrl: n.actionUrl } : {}),
      ...(n.data ? { data: n.data } : {}),
    };
    items.push(notification);
    writeJson(this.path, items);
    return notification;
  }

  async list(): Promise<Notification[]> {
    return readJson<Notification[]>(this.path, []);
  }
}

export class FileJournal implements Journal {
  private readonly path: string;

  constructor(dir: string) {
    this.path = join(dir, 'journal.json');
  }

  async record(entry: JournalEntry): Promise<void> {
    const entries = readJson<JournalEntry[]>(this.path, []).filter(
      (e) => e.messageId !== entry.messageId,
    );
    entries.push(entry);
    writeJson(this.path, entries);
  }

  async byQuoteRef(ref: string): Promise<JournalEntry | undefined> {
    return readJson<JournalEntry[]>(this.path, []).find((e) => e.merchantQuoteRef === ref);
  }

  async byMessage(messageId: string): Promise<JournalEntry | undefined> {
    return readJson<JournalEntry[]>(this.path, []).find((e) => e.messageId === messageId);
  }

  async all(): Promise<JournalEntry[]> {
    return readJson<JournalEntry[]>(this.path, []);
  }
}
