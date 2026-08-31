/**
 * The console.
 *
 * A single self-contained page, served by the API itself. Deliberately not a
 * separate front-end build: it exists so a human can see what they approved and
 * what the agent then did, and a second toolchain would be cost without benefit.
 *
 * It is READ-ONLY over the audit trail plus the two human actions that matter —
 * revoking a mandate and approving a refund. Signing happens elsewhere, because
 * the signing key must never reach this server.
 */
import type { FastifyInstance } from 'fastify';

import type { Config } from '../config.js';

export async function consoleRoutes(app: FastifyInstance, _config: Config) {
  app.get('/console', async (_request, reply) => {
    reply.type('text/html; charset=utf-8');
    return CONSOLE_HTML;
  });
}

const CONSOLE_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>RazorTrust Console</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff; --fg: #14161a; --muted: #5c6370; --line: #e3e6ea;
    --card: #f7f8fa; --allow: #0f7b3d; --block: #c02626; --warn: #9a6400;
    --accent: #1a56db;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1115; --fg: #e6e8eb; --muted: #9aa1ac; --line: #262b33;
      --card: #171a20; --allow: #4ade80; --block: #f87171; --warn: #fbbf24;
      --accent: #7aa2f7;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2rem 1.25rem; background: var(--bg); color: var(--fg);
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .wrap { max-width: 60rem; margin: 0 auto; }
  h1 { font-size: 1.35rem; margin: 0 0 .25rem; }
  .sub { color: var(--muted); margin: 0 0 1.75rem; }
  h2 { font-size: 1rem; margin: 2rem 0 .75rem; text-transform: uppercase;
       letter-spacing: .06em; color: var(--muted); }
  .bar { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; margin-bottom: 1rem; }
  input, button {
    font: inherit; padding: .45rem .7rem; border-radius: 6px;
    border: 1px solid var(--line); background: var(--bg); color: var(--fg);
  }
  input { min-width: 16rem; }
  button { cursor: pointer; background: var(--card); }
  button:hover { border-color: var(--accent); }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 8px;
          padding: .9rem 1rem; margin-bottom: .6rem; }
  .row { display: flex; gap: .75rem; align-items: baseline; flex-wrap: wrap; }
  .seq { color: var(--muted); font-variant-numeric: tabular-nums; min-width: 2.5rem; }
  .type { font-weight: 600; }
  .hash { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: .8rem; }
  pre { margin: .5rem 0 0; overflow-x: auto; font-size: .8rem; color: var(--muted);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .pill { display: inline-block; padding: .1rem .5rem; border-radius: 999px;
          font-size: .75rem; font-weight: 600; border: 1px solid currentColor; }
  .ok { color: var(--allow); } .bad { color: var(--block); } .warn { color: var(--warn); }
  .empty { color: var(--muted); font-style: italic; }
  table { width: 100%; border-collapse: collapse; }
  td, th { text-align: left; padding: .4rem .5rem; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 600; font-size: .8rem; text-transform: uppercase; }
</style>
</head>
<body>
<div class="wrap">
  <h1>RazorTrust</h1>
  <p class="sub">What a human approved, and what the agent actually did.</p>

  <div class="bar">
    <input id="pid" type="password" placeholder="Principal token (rzt_principal_…)" />
    <button id="load">Load</button>
    <button id="verify">Verify audit chain</button>
    <span id="status"></span>
  </div>

  <h2>Integrity</h2>
  <div id="integrity" class="card empty">Not checked yet.</div>

  <h2>Audit trail</h2>
  <div id="events" class="empty">Paste your principal token and press Load.</div>
</div>

<script type="module">
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Event types that represent a refusal, so they read as such at a glance.
const BLOCKING = new Set([
  'drift.blocked', 'mandate.verification_failed', 'mandate.revoked',
  'quote.ai_rejected', 'capture.deadline_check_failed', 'capture.failed',
  'authorization.failed', 'webhook.replay_rejected', 'refund.failed',
]);
const MONEY = new Set([
  'capture.succeeded', 'refund.succeeded', 'authorization.succeeded',
]);

function headers() {
  const token = $('pid').value.trim();
  if (!token) throw new Error('A principal token is required');
  // Kept per-browser only. It never leaves this origin and is never logged.
  sessionStorage.setItem('razortrust.token', token);
  return { authorization: 'Bearer ' + token };
}

async function load() {
  $('status').textContent = 'Loading…';
  try {
    const res = await fetch('/v1/audit?limit=500', { headers: headers() });
    const body = await res.json();
    if (!res.ok) throw new Error(body.message ?? res.statusText);

    const events = body.events ?? [];
    $('events').className = events.length ? '' : 'empty';
    $('events').innerHTML = events.length
      ? events.map(renderEvent).join('')
      : 'No events for this principal.';
    $('status').textContent = events.length + ' events';
  } catch (err) {
    $('status').textContent = '';
    $('events').className = 'empty';
    $('events').textContent = 'Could not load: ' + err.message;
  }
}

function renderEvent(e) {
  const cls = BLOCKING.has(e.eventType) ? 'bad' : MONEY.has(e.eventType) ? 'ok' : '';
  const payload = JSON.stringify(e.payload, null, 2);
  return \`<div class="card">
    <div class="row">
      <span class="seq">\${e.seq}</span>
      <span class="type \${cls}">\${esc(e.eventType)}</span>
      <span class="hash">\${esc(e.actorType)}:\${esc(e.actorId)}</span>
      <span class="hash" style="margin-left:auto">\${esc(e.hash.slice(0, 16))}…</span>
    </div>
    \${payload === '{}' ? '' : '<pre>' + esc(payload) + '</pre>'}
  </div>\`;
}

async function verify() {
  $('integrity').className = 'card';
  $('integrity').textContent = 'Verifying…';
  try {
    const res = await fetch('/v1/audit/verify', { headers: headers() });
    const r = await res.json();

    // A "full" verification without a signed checkpoint is weaker evidence,
    // and the page says so rather than showing an unqualified tick.
    const pill = r.ok
      ? '<span class="pill ok">CHAIN INTACT</span>'
      : '<span class="pill bad">TAMPERED</span>';
    const mode = r.mode === 'checkpointed'
      ? '<span class="pill ok">SIGNED CHECKPOINT</span>'
      : '<span class="pill warn">UNSIGNED — replay only</span>';

    $('integrity').innerHTML = \`<div class="row">\${pill} \${mode}</div>
      <pre>\${esc(JSON.stringify(r, null, 2))}</pre>\`;
  } catch (err) {
    $('integrity').textContent = 'Could not verify: ' + err.message;
  }
}

$('load').addEventListener('click', load);
$('verify').addEventListener('click', verify);
$('pid').addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });

try {
  // sessionStorage, not localStorage: a bearer token should not outlive the tab.
  const saved = sessionStorage.getItem('razortrust.token');
  if (saved) { $('pid').value = saved; load(); }
} catch { /* private mode; the field just starts empty */ }
</script>
</body>
</html>`;
