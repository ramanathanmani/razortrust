/**
 * The human approval link.
 *
 * RazorTrust holds no payment instrument, so a person has to complete the
 * payment on Razorpay's own page. This is the link they follow, and it is a
 * capability: holding it is what authorises the approval, because there is no
 * external login in this system.
 *
 * That makes the token's properties the whole security story:
 *
 *   - stored only as a SHA-256 hash, so a leaked database yields nothing usable
 *   - bound to ONE intent and ONE principal — the mandate's owner
 *   - expiring, so an old link in someone's inbox is inert
 *   - one-time, consumed at the moment checkout opens
 *
 * And a valid token is still not enough. Every load re-checks the owner, the
 * mandate signature, and the drift rules — so a link minted before a mandate
 * was revoked, or before the merchant changed the price, refuses to open.
 */
import { createHash, randomUUID } from 'node:crypto';

import {
  evaluateDrift,
  mandateTermsSchema,
  verifyMandate,
  type DriftViolation,
} from '@razortrust/core';
import { prisma } from '@razortrust/db';
import type { FastifyInstance } from 'fastify';

import { audit } from '../audit.js';
import type { Config } from '../config.js';
import { conflict, notFound } from '../errors.js';

/** How long an approval link stays usable. */
export const APPROVAL_TOKEN_TTL_MS = 30 * 60 * 1000;

export const hashApprovalToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

/** Mint a link for one intent. The plaintext token exists only in the URL. */
export async function issueApprovalToken(args: {
  tenantId: string;
  intentId: string;
  principalId: string;
  now: Date;
  ttlMs?: number;
}): Promise<{ token: string; expiresAt: Date }> {
  const token = `${randomUUID()}${randomUUID()}`.replace(/-/g, '');
  const expiresAt = new Date(args.now.getTime() + (args.ttlMs ?? APPROVAL_TOKEN_TTL_MS));

  await prisma.approvalToken.create({
    data: {
      tenantId: args.tenantId,
      intentId: args.intentId,
      principalId: args.principalId,
      tokenHash: hashApprovalToken(token),
      expiresAt,
    },
  });

  return { token, expiresAt };
}

type CheckFailure = { code: string; message: string; violations?: readonly DriftViolation[] };

/**
 * Everything that must still be true for this link to open.
 *
 * Deliberately re-run on every load rather than trusted from mint time: the
 * gap between "the agent asked" and "the human clicks" is exactly where a
 * mandate gets revoked or a merchant reprices.
 */
async function validateApproval(token: string, now: Date) {
  const row = await prisma.approvalToken.findUnique({
    where: { tokenHash: hashApprovalToken(token) },
    include: {
      intent: { include: { authorization: true, merchant: true } },
      principal: true,
    },
  });

  if (!row) return { ok: false as const, failure: { code: 'INVALID_TOKEN', message: 'This approval link is not valid.' } };

  if (row.usedAt) {
    return {
      ok: false as const,
      failure: {
        code: 'TOKEN_ALREADY_USED',
        message: 'This approval link has already been used. Ask the agent for a new one.',
      },
    };
  }

  if (row.expiresAt <= now) {
    return {
      ok: false as const,
      failure: {
        code: 'TOKEN_EXPIRED',
        message: 'This approval link has expired. Ask the agent for a new one.',
      },
    };
  }

  if (row.principal.status !== 'active') {
    return {
      ok: false as const,
      failure: { code: 'PRINCIPAL_INACTIVE', message: 'This account is no longer active.' },
    };
  }

  const mandateRow = await prisma.mandate.findUnique({ where: { id: row.intent.mandateId } });
  if (!mandateRow) {
    return { ok: false as const, failure: { code: 'MANDATE_MISSING', message: 'The mandate no longer exists.' } };
  }

  // The link belongs to the person who signed the mandate. Nobody else's
  // approval counts, even inside the same tenant.
  if (mandateRow.principalId !== row.principalId) {
    return {
      ok: false as const,
      failure: {
        code: 'NOT_MANDATE_OWNER',
        message: 'This link does not belong to the person who approved this mandate.',
      },
    };
  }

  const verification = verifyMandate({
    mandate: {
      terms: mandateTermsSchema.parse(JSON.parse(mandateRow.termsJson)),
      termsHash: mandateRow.termsHash,
      signature: mandateRow.signature ?? '',
      signedByPublicKeyPem: mandateRow.signedByPublicKeyPem ?? '',
      signedAt: mandateRow.signedAt?.toISOString() ?? '',
    },
    state: {
      status: mandateRow.status as 'active',
      usesCount: mandateRow.usesCount,
      cumulativeAuthorizedPaise: mandateRow.cumulativeAuthorizedPaise,
      ...(mandateRow.revokedAt ? { revokedAt: mandateRow.revokedAt.toISOString() } : {}),
    },
    presentedBy: { tenantId: mandateRow.tenantId, agentId: mandateRow.agentId },
    now,
  });

  if (!verification.ok) {
    return {
      ok: false as const,
      failure: {
        code: verification.failures[0]?.code ?? 'MANDATE_REJECTED',
        message: `This purchase can no longer be approved: ${verification.failures.map((f) => f.message).join('; ')}`,
      },
    };
  }

  const quote = await prisma.quote.findFirst({
    where: { intentId: row.intentId },
    orderBy: { createdAt: 'desc' },
  });
  if (!quote) {
    return { ok: false as const, failure: { code: 'NO_QUOTE', message: 'There is no quote to approve.' } };
  }

  // The rules run again here. Passing them when the agent asked is not a
  // ticket that stays valid while the merchant changes the price.
  const drift = evaluateDrift({
    mandate: verification.terms,
    quote: JSON.parse(quote.structuredJson),
    stage: 'pre_authorization',
    now,
    cumulativeAuthorizedPaise:
      mandateRow.cumulativeAuthorizedPaise - (row.intent.authorization?.amountPaise ?? 0n),
  });

  if (drift.decision === 'block') {
    return {
      ok: false as const,
      failure: {
        code: 'BLOCKED_BY_DRIFT',
        message: 'This quote no longer matches what was approved.',
        violations: drift.violations,
      },
    };
  }

  if (!row.intent.authorization?.rzpOrderId) {
    return { ok: false as const, failure: { code: 'NO_ORDER', message: 'No gateway order exists for this purchase.' } };
  }

  return { ok: true as const, row, mandateRow, quote };
}

export async function approvalRoutes(app: FastifyInstance, config: Config) {
  /**
   * The page a human lands on.
   *
   * Validates without consuming, so a refresh does not burn the link. The
   * token is spent by the POST below, when checkout actually opens.
   */
  app.get('/approve/:token', async (request, reply) => {
    const { token } = request.params as { token: string };
    const now = new Date();

    const result = await validateApproval(token, now);
    reply.type('text/html; charset=utf-8');

    if (!result.ok) {
      return reply.status(result.failure.code === 'INVALID_TOKEN' ? 404 : 409)
        .send(renderPage({ failure: result.failure }));
    }

    return reply.send(
      renderPage({
        approval: {
          token,
          intentId: result.row.intentId,
          merchantName: result.row.intent.merchant.displayName,
          amountPaise: (result.row.intent.authorization?.amountPaise ?? 0n).toString(),
          currency: result.row.intent.currency,
          orderId: result.row.intent.authorization?.rzpOrderId ?? '',
          expiresAt: result.row.expiresAt.toISOString(),
          keyId: config.RAZORPAY_KEY_ID,
        },
      }),
    );
  });

  /**
   * Consume the token and hand back what Razorpay Checkout needs.
   *
   * The whole validation runs a second time here, inside the same request that
   * spends the token — so a mandate revoked while the page sat open is caught
   * at the last possible moment rather than at page load.
   */
  app.post('/approve/:token/start', async (request, reply) => {
    const { token } = request.params as { token: string };
    const now = new Date();

    const result = await validateApproval(token, now);
    if (!result.ok) {
      throw result.failure.code === 'INVALID_TOKEN'
        ? notFound('Approval link')
        : conflict(result.failure.message, {
            code: result.failure.code,
            ...(result.failure.violations ? { violations: result.failure.violations } : {}),
          });
    }

    // Consume it. The conditional update is the replay guard: two concurrent
    // clicks, and only one sees a count of 1.
    const consumed = await prisma.approvalToken.updateMany({
      where: { id: result.row.id, usedAt: null },
      data: { usedAt: now, usedByIp: request.ip ?? null },
    });
    if (consumed.count !== 1) {
      throw conflict('This approval link has already been used.', { code: 'TOKEN_ALREADY_USED' });
    }

    await audit(config, {
      tenantId: result.row.tenantId,
      actorType: 'human',
      actorId: result.row.principalId,
      eventType: 'authorization.requested',
      intentId: result.row.intentId,
      mandateId: result.mandateRow.id,
      payload: {
        via: 'approval_link',
        orderId: result.row.intent.authorization?.rzpOrderId ?? null,
        amountPaise: (result.row.intent.authorization?.amountPaise ?? 0n).toString(),
      },
      occurredAt: now.toISOString(),
    });

    return reply.send({
      orderId: result.row.intent.authorization?.rzpOrderId ?? '',
      amountPaise: (result.row.intent.authorization?.amountPaise ?? 0n).toString(),
      currency: result.row.intent.currency,
      keyId: config.RAZORPAY_KEY_ID,
      merchantName: result.row.intent.merchant.displayName,
      // Empty in test mode. The page shows a clear notice rather than opening
      // a checkout that cannot work.
      checkoutAvailable: Boolean(config.RAZORPAY_KEY_ID),
    });
  });
}

// --------------------------------------------------------------------------
// The page
// --------------------------------------------------------------------------

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

const rupees = (paise: string) =>
  `₹${(Number(paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

interface PageArgs {
  approval?: {
    token: string;
    intentId: string;
    merchantName: string;
    amountPaise: string;
    currency: string;
    orderId: string;
    expiresAt: string;
    keyId: string;
  };
  failure?: CheckFailure;
}

function renderPage(args: PageArgs): string {
  const body = args.failure ? renderFailure(args.failure) : renderApproval(args.approval!);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Approve payment · RazorTrust</title>
<style>
  :root {
    color-scheme: light dark;
    --bg:#fff; --fg:#14161a; --muted:#5c6370; --line:#e3e6ea; --card:#f7f8fa;
    --ok:#0f7b3d; --bad:#c02626; --warn:#9a6400; --accent:#1a56db;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#0f1115; --fg:#e6e8eb; --muted:#9aa1ac; --line:#262b33; --card:#171a20;
      --ok:#4ade80; --bad:#f87171; --warn:#fbbf24; --accent:#7aa2f7;
    }
  }
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:2rem 1.25rem;
    background:var(--bg);color:var(--fg);
    font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;
    padding:2rem;max-width:26rem;width:100%}
  h1{font-size:1.15rem;margin:0 0 .35rem}
  .sub{color:var(--muted);margin:0 0 1.5rem;font-size:.9rem}
  dl{display:grid;grid-template-columns:auto 1fr;gap:.5rem 1rem;margin:0 0 1.5rem;font-size:.9rem}
  dt{color:var(--muted)}
  dd{margin:0;text-align:right;font-variant-numeric:tabular-nums}
  .amount{font-size:1.6rem;font-weight:700;font-variant-numeric:tabular-nums;margin:0 0 1.25rem}
  button{font:inherit;font-weight:600;width:100%;padding:.7rem;border-radius:8px;
    border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer}
  button:hover{filter:brightness(1.08)}
  button:disabled{opacity:.55;cursor:not-allowed}
  button:focus-visible{outline:2px solid var(--fg);outline-offset:2px}
  .note{margin-top:1rem;font-size:.8rem;color:var(--muted)}
  .fail h1{color:var(--bad)}
  .code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.75rem;
    color:var(--muted);margin-top:1rem}
  ul{margin:.5rem 0 0;padding-left:1.1rem;color:var(--muted);font-size:.85rem}
  .pill{display:inline-block;padding:.1rem .5rem;border-radius:999px;font-size:.7rem;
    font-weight:700;border:1px solid currentColor;color:var(--warn);margin-bottom:1rem}
  #status{margin-top:1rem;font-size:.85rem}
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function renderFailure(f: CheckFailure): string {
  const violations = f.violations?.length
    ? `<ul>${f.violations.map((v) => `<li>${esc(v.ruleId)} — ${esc(v.message)}</li>`).join('')}</ul>`
    : '';
  return `<div class="card fail">
  <h1>Can't approve this</h1>
  <p class="sub">${esc(f.message)}</p>
  ${violations}
  <p class="code">${esc(f.code)}</p>
</div>`;
}

function renderApproval(a: NonNullable<PageArgs['approval']>): string {
  const testMode = !a.keyId;
  return `<div class="card">
  ${testMode ? '<span class="pill">TEST MODE — no gateway key configured</span>' : ''}
  <h1>Approve this payment</h1>
  <p class="sub">An agent has requested this purchase under a mandate you signed.</p>

  <p class="amount">${esc(rupees(a.amountPaise))}</p>

  <dl>
    <dt>Merchant</dt><dd>${esc(a.merchantName)}</dd>
    <dt>Order</dt><dd>${esc(a.orderId)}</dd>
    <dt>Link expires</dt><dd>${esc(new Date(a.expiresAt).toLocaleString('en-IN'))}</dd>
  </dl>

  <button id="pay">Pay ${esc(rupees(a.amountPaise))}</button>
  <div id="status"></div>
  <p class="note">This link works once. RazorTrust never sees your card — Razorpay
  collects it, and the money is only held until the goods are confirmed.</p>
</div>

<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
<script>
const btn = document.getElementById('pay');
const status = document.getElementById('status');
const TOKEN = ${JSON.stringify(a.token)};

btn.addEventListener('click', async () => {
  btn.disabled = true;
  status.textContent = 'Checking…';

  let data;
  try {
    // Spends the token and re-runs every check server-side.
    const res = await fetch('/approve/' + encodeURIComponent(TOKEN) + '/start', { method: 'POST' });
    data = await res.json();
    if (!res.ok) {
      status.textContent = data.message || 'This link can no longer be used.';
      return;
    }
  } catch (err) {
    status.textContent = 'Could not reach RazorTrust. Try again.';
    btn.disabled = false;
    return;
  }

  if (!data.checkoutAvailable || typeof Razorpay === 'undefined') {
    // No gateway key, or the script was blocked. Say so plainly rather than
    // opening a checkout that cannot complete.
    status.textContent =
      'Approval recorded. Razorpay Checkout is not configured in this environment, ' +
      'so no live payment was started.';
    return;
  }

  status.textContent = '';
  new Razorpay({
    key: data.keyId,
    order_id: data.orderId,
    amount: Number(data.amountPaise),
    currency: data.currency,
    name: data.merchantName,
    description: 'Approved under a RazorTrust mandate',
    handler: () => {
      status.textContent = 'Payment authorised. You can close this page.';
    },
    modal: {
      ondismiss: () => {
        status.textContent = 'Checkout closed. This link has already been used.';
      },
    },
  }).open();
});
</script>`;
}
