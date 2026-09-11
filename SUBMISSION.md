# Steward — Agents for Humans hackathon submission pack

Everything needed to submit, in one file. Repo: **[make public before the
deadline]** · Track: **Everyday Agents** (confirmed) · License: **MIT**
(detectable in the repo root and About).

**Paste-ready Devpost fields: [`docs/DEVPOST.md`](./docs/DEVPOST.md).**
**builder.aws bonus-post drafts (titles include "Agents for Humans" as
required; +0.2 each, max +0.6): [`docs/blog/`](./docs/blog/).**

---

## 1. One-line pitch

Steward is an autonomous procurement agent for small shops and cafes: it works
supplier mailboxes overnight, placing **human-completable** payment holds inside
a signed mandate, capturing only what the owner approved, and chasing
deliveries — then only interrupts the human for two real decisions (approve a
payment, approve a refund).

## 2. Problem, audience, why it matters (video outline — also the Devpost answers)

**Problem.** Agents are about to hold budgets and pay vendors, but today's
pattern is "give the agent a card / an API key with a balance." Every prompt
injection, arithmetic error, or compromised supplier email then becomes a
direct path to money movement. Owners get either no automation (do every PO
themselves) or unsupervised automation, with nothing in between.

**Who it is for.** Independent cafes, restaurants, and small retailers that
reorder supplies weekly, run off supplier emails and WhatsApp quotes, and do not
have a finance team — e.g. a cafe owner who restocks beans and cups every week
and loses real money on shortages, double-orders, and delivery disputes they
never have time to chase.

**Why it matters.** The agent should do the boring 90% — read quotes, structure
figures, place holds, sweep captures, record deliveries, compute what's owed —
and keep the human exactly at the two moments that require judgement:
authorising payment after seeing the figures, and authorising money back after
seeing what actually arrived. Steward makes that boundary *technical*, enforced
by signatures and deterministic rules, not by prompt instructions.

## 3. What is genuinely agentic (Strands use)

- The agent is a real **Strands `Agent` with 12 Zod tools**, and a fresh
  tool-loop conversation per mailbox message (`apps/agent/src/cycle.ts`,
  `tools.ts`, `agent.ts`).
- It plans multi-step work on its own: open intent → ground a messy quote email
  into structured data → ask for a verdict → place a hold → notify → journal;
  later, sweep approved holds and capture them after re-verification; on
  delivery notes, parse → match to the order → record → ask the settlement
  engine → attempt (and be refused) → escalate with exact data.
- Tool failures and Zod validation errors feed back through the normal Strands
  loop; a runaway loop is bounded by `limits.turns`.
- A custom Strands `Model` (`scripted-model.ts`) emits the same streaming
  tool-use protocol as Bedrock, making the full system runnable, demoable, and
  tested with **zero API credits**; production swaps in `BedrockModel`
  (`STEWARD_MODEL=bedrock`).
- Durable state lives in the API/journal, not the model's context: the agent
  can die, restart, and sweep later.

## 4. The controls (why it is a complete product, not a POC)

1. **Signed mandate** (Ed25519): ceiling, per-item caps and quantities,
   merchant allowlist, delivery window, cumulative cap, capture deadline.
2. **Deterministic drift engine** — fail-closed rule table; the model never
   produces a verdict.
3. **Manual-capture holds only** — the agent cannot complete checkout; the
   human uses a one-time, expiring, principal-bound token on the gateway page.
4. **Re-verification at capture** — mandate hash and all rules re-run.
5. **Settlement recommends, humans execute** on ordinary mandates; an agent
   attempting the refund gets a 403; amounts must match exactly.
6. **Append-only, hash-chained audit log** with Ed25519 checkpoints verified
   against an out-of-band trust anchor; SQLite triggers block UPDATE/DELETE.
7. **Idempotency keys on every money-moving call**; bearer tokens are stored
   only as SHA-256 hashes.

## 5. Live end-to-end demonstration

`npm run demo` (script: `apps/agent/src/demo.ts`, narration transcript
equivalent in `apps/agent/README.md`). Real HTTP API via in-process Fastify
inject, real SQLite database, real Strands tool loop, fake payment gateway,
deterministic model:

1. Three overnight emails: one good restock, one premium-priced over the
   per-unit cap, one with a prompt injection plus arithmetically wrong ₹25,000
   total → exactly one hold request and two rule-based blocks; injection text
   is never acted on.
2. Human opens the one-time approval link and checks the figures.
3. The sweep captures the approved hold after re-running every rule.
4. Delivery arrives one coffee bag short; the engine recommends a ₹2,350
   partial refund; the agent's refund call is refused; the human executes it.
5. Audit verification returns `ok: true, mode: checkpointed`.

Automated equivalent: `npm test` and `npm run agent:test:e2e` (CI green).

## 6. Architecture diagram

See [`docs/architecture.md`](./docs/architecture.md) (system, sequence,
settlement, audit, and model-swap diagrams).

## 7. Setup instructions (judges need not run anything, but can)

```bash
npm install
cp .env.example packages/db/.env
npm run db:generate && npm run db:push
npm test                    # full hermetic + API suite
npm run agent:test:e2e      # full-server Steward E2E
npm run demo                # narrated end-to-end story, no credentials
```

Amazon Bedrock mode (optional, needs AWS credentials):

```bash
STEWARD_MODEL=bedrock AWS_REGION=us-east-1 \
STEWARD_BEDROCK_MODEL=us.anthropic.claude-sonnet-4-20250514-v1:0 \
npm run agent:watch
```

No native Prisma engine download is required: the project generates the client
offline via Prisma's schema WASM and runs the query engine in WASM through a
libSQL driver adapter, and `npm run db:push` verifies the hand-maintained
SQLite schema against the schema-derived DMMF.

## 8. Pre-existing-code disclosure (required by the rules)

This repository **originated for an earlier, unsubmitted Razorpay AI Buildathon
prototype**. The earlier work comprises, predominantly: the deterministic
control plane — mandate terms and signing (`packages/core`), the drift and
settlement rule engines, the Fastify service and payment lifecycle
(`apps/api`), the Prisma data model and append-only/audit machinery
(`packages/db`), the Razorpay adapters and fakes (`packages/adapters`), the
Next.js console (`apps/web`), and the adversarial `examples/rogue-agent` demo.

**Created during the Agents for Humans submission period (Aug 10 – Sep 14,
2026):** the entire Steward agent package (`apps/agent`) — the Strands Agents
SDK integration, 12 tools, agent and cycle orchestration, deterministic
`ScriptedModel`, Bedrock model option, mailbox/outbox/journal runtimes,
provisioning/setup CLIs, the narrated demo, and all agent tests; the
deterministic quote email parser feeding the agent; the offline/WASM database
toolchain so the system installs without native engine downloads; the
checkpoint trust-anchor enforcement; CI; agent documentation, diagrams, and
this submission material. No sponsor (AWS/Strands) technology was present in
the earlier prototype — the autonomous agent and all SDK integration are new.

## 9. Judging rubric cross-reference

- **Technical Implementation** — genuine multi-tool Strands loops with custom
  and Bedrock models; deterministic out-of-band money controls; full E2E tests;
  replay/idempotency/audit depth. AgentCore deployment noted as a follow-up; the
  agent is a plain process with an HTTP client and is deployable as a
  container/AgentCore workload without code changes.
- **Design** — coherent product with owner console, setup/run CLIs, a
  narrated demo, and authority boundaries visible both in code and on disk.
- **Potential Impact** — concrete audience (independent retailers doing email
  reorders) and a precise failure they face weekly (disputes, overcharges,
  shortages) plus the emerging gap of budget-holding agents without guardrails.
- **Creativity & Originality** — non-obvious Strands use: the LLM as a
  constrained orchestrator that is *structurally* unable to move money, with a
  deterministic signed policy plane and explicit human-in-the-loop escalations.
- **Presentation** — ≤5-minute video following problem → audience → why it
  matters → live end-to-end run.

## 10. Submission checklist

- [ ] Repo made **public**, MIT license detected in About (LICENSE is at repo
      root; GitHub shows it in About automatically)
- [ ] Video ≤5 min uploaded to YouTube (unlisted), covers problem / audience /
      why + live `npm run demo` screen recording with voiceover — script and
      shot list: [`docs/VIDEO_SCRIPT.md`](./docs/VIDEO_SCRIPT.md), pre-generated
      narration: [`docs/voiceover/`](./docs/voiceover), reference captions:
      [`docs/demo-transcript.txt`](./docs/demo-transcript.txt)
- [ ] Devpost fields pasted from [`docs/DEVPOST.md`](./docs/DEVPOST.md)
      (title, tagline, long description, disclosure, tags, gallery captions)
- [ ] Architecture diagram attached/linked (section 6; mermaid renders on
      GitHub)
- [ ] AWS Builder ID linked to the Devpost profile
- [ ] $50 credit form (due Sep 11 12pm PT)
- [ ] Optional: publish the three drafts in [`docs/blog/`](./docs/blog) on
      builder.aws (titles already include "Agents for Humans")
- [ ] Optional: live deploy (container/AgentCore mapping in
      [`docs/deployment.md`](./docs/deployment.md))

## 11. Verification state (this checkout)

- Clean-state install → `db:generate` → `db:push` → `build` → all tests:
  269 tests pass; gated E2E: 13 tests pass; `db:verify` passes.
- `npm run demo` passes end to end, audit in `mode: checkpointed`.
- Live path also verified manually: real API server (`npm run dev:api`) +
  `npm run agent:setup` + `npm run agent:once` over HTTP with the file mailbox
  (1 decision, 2 blocks), idempotent re-runs do nothing.
- GitHub Actions green on Node 20 and 22 (PR #1).
