/**
 * The API client.
 *
 * Money arrives as a decimal string of paise and is formatted for display only
 * — it is never parsed into a JS number and then re-rendered, because a
 * ceiling that survives a float round-trip by luck is not a ceiling. The one
 * `Number()` below is inside the formatter, at the very end of the pipeline.
 */

export interface Mandate {
  id: string;
  status: string;
  currency: string;
  maxAmountPaise: string;
  allowedSkus: string[];
  allowedMerchants: string[];
  deliveryWindow: { startsAt: string; endsAt: string };
  signedBy: string;
  signedAt: string | null;
  signatureAlgorithm: string;
  signatureValid: boolean;
  termsHash: string;
  usesCount: number;
  maxUses: number;
  revokedAt: string | null;
}

export interface DriftViolation {
  ruleId: string;
  message: string;
}

export interface ComparisonRow {
  field: string;
  mandate: string;
  quote: string | null;
  match: boolean;
}

export interface Drift {
  decision: 'allow' | 'block';
  stage: string;
  rulesVersion: string;
  evaluatedAt: string;
  quoteId: string | null;
  quoteHash: string | null;
  quoteSource: string | null;
  violations: DriftViolation[];
  comparison: ComparisonRow[];
  otherViolations: string[];
}

export interface Settlement {
  id: string;
  recommendation: 'none' | 'partial_refund' | 'full_refund' | 'escalate';
  refundAmountPaise: string;
  reasons: { ruleId: string; verdict: string; message: string }[];
  rulesVersion: string;
  evaluatedAt: string;
  executedAt: string | null;
  autoRefundAllowed: boolean;
}

export interface Intent {
  id: string;
  state: string;
  merchantName: string;
  currency: string;
  authorizedAmountPaise: string | null;
  capturedAmountPaise: string | null;
  refundedAmountPaise: string | null;
  rzpOrderId: string | null;
  rzpPaymentId: string | null;
  captureMode: string | null;
  captureDeadline: string | null;
}

export interface AuditEvent {
  seq: number;
  eventType: string;
  actorType: string;
  actorId: string;
  payload: Record<string, unknown>;
  hash: string;
  occurredAt: string;
}

export interface ChainStatus {
  ok: boolean;
  mode?: 'checkpointed' | 'full';
  headSeq?: number;
  headHash?: string;
  message?: string;
}

export interface Overview {
  mandate: Mandate | null;
  drift: Drift | null;
  settlement: Settlement | null;
  intent: Intent | null;
  audit: { blockedCount: number; events: AuditEvent[] };
  chain: ChainStatus;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** A bad token is a different problem from a dead API, and reads differently. */
  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

const TOKEN_KEY = 'razortrust.principalToken';

export function readToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    // Private mode, or storage blocked. The gate simply asks again.
    return null;
  }
}

export function writeToken(token: string): void {
  try {
    // sessionStorage, not localStorage: a bearer token should not outlive the tab.
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* the session still works, it just will not be remembered */
  }
}

export function clearToken(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* nothing to clear */
  }
}

/**
 * Fetch through the same-origin `/api` rewrite (see next.config.mjs).
 *
 * Errors are surfaced, never swallowed into an empty render. A console that
 * silently shows nothing when the API is down is worse than one that says the
 * API is down — the whole point of this screen is knowing what actually happened.
 */
async function request<T>(path: string, token: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'Could not reach the RazorTrust API. Is it running on port 8080?');
  }

  if (!res.ok) {
    let message: string | null = null;
    let code: string | undefined;
    try {
      const body = await res.json();
      message = body.message ?? null;
      code = body.error;
    } catch {
      // A non-JSON error body means this did not come from the API at all —
      // most often the dev-server rewrite failing because nothing is listening
      // on the API port. The proxy turns a dead upstream into a plain 500, so
      // a missing JSON body is the signal, not the status code.
      message = null;
    }

    if (res.status === 401) {
      throw new ApiError(401, 'That principal token was not accepted.', code);
    }
    if (message === null && res.status >= 500) {
      throw new ApiError(
        res.status,
        'Could not reach the RazorTrust API. Start it with `npm run dev:api`.',
        code,
      );
    }

    throw new ApiError(res.status, message ?? res.statusText, code);
  }

  return res.json() as Promise<T>;
}

export const fetchOverview = (token: string, mandateId?: string) =>
  request<Overview>(
    `/v1/console/overview${mandateId ? `?mandateId=${encodeURIComponent(mandateId)}` : ''}`,
    token,
  );

// --------------------------------------------------------------------------
// Formatting
// --------------------------------------------------------------------------

/** Paise string to a rupee display string. Presentation only. */
export function formatMoney(paise: string | null | undefined, currency = 'INR'): string {
  if (paise === null || paise === undefined) return '—';
  const symbol = currency === 'INR' ? '₹' : `${currency} `;
  const n = Number(paise) / 100;
  return `${symbol}${n.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatTimeUtc(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toISOString().slice(11, 19);
}

export function formatDateUtc(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toISOString().slice(0, 10);
}

/** "2026-09-02T…Z" → "Sep 02", matching the console's compact date style. */
export function formatDayMonth(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', timeZone: 'UTC' });
}

/**
 * Format whichever ISO instants appear in a comparison cell.
 *
 * The API sends the mandate window as one string with an en dash between two
 * instants, so this rewrites each instant in place rather than parsing the
 * cell into fields the API never promised.
 */
export function formatInstantsInText(text: string): string {
  return text.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, (m) => formatDayMonth(m));
}

/** `drift.blocked` → `DRIFT_BLOCKED`, to match the console's event styling. */
export function eventLabel(eventType: string): string {
  return eventType.replace(/\./g, '_').toUpperCase();
}

/** Events that represent a refusal, so they read as such at a glance. */
const BLOCKING = new Set([
  'drift.blocked',
  'mandate.verification_failed',
  'mandate.revoked',
  'quote.ai_rejected',
  'capture.deadline_check_failed',
  'capture.failed',
  'authorization.failed',
  'webhook.replay_rejected',
  'refund.failed',
]);

export const isBlockingEvent = (eventType: string): boolean => BLOCKING.has(eventType);

/** A one-line human summary of an audit event, for the Detail column. */
export function eventDetail(e: AuditEvent): string {
  const p = e.payload as Record<string, string | number | string[] | undefined>;

  if (Array.isArray(p.violations) && p.violations.length > 0) {
    return `Blocked: ${(p.violations as string[]).join(', ')}`;
  }
  if (Array.isArray(p.failures) && p.failures.length > 0) {
    return `Mandate rejected: ${(p.failures as string[]).join(', ')}`;
  }
  if (p.amountPaise) return `Amount ${formatMoney(String(p.amountPaise))}`;
  if (p.refundAmountPaise) {
    return `${p.recommendation ?? 'settlement'} · ${formatMoney(String(p.refundAmountPaise))}`;
  }
  if (p.totalPaise) return `Quote total ${formatMoney(String(p.totalPaise))}`;
  if (p.message) return String(p.message);
  if (p.reason) return String(p.reason);
  if (p.termsHash) return `Terms ${String(p.termsHash).slice(0, 12)}…`;
  if (p.eventType) return String(p.eventType);

  return `${e.actorType}:${e.actorId}`;
}
