# RazorTrust

**An AI agent can only pay for what a human actually approved.**

Built for the Razorpay AI Buildathon 2026.

The agent never holds a payment instrument. A human signs a **Mandate** once —
price ceiling, allowed SKUs, merchant, delivery window. Before any money moves,
plain deterministic code compares the merchant's final quote against that
mandate and blocks on drift. Payments are short-lived authorization holds, never
auto-capture. After delivery, a rules engine recommends refund, partial refund,
or escalate. Every step lands in an append-only, tamper-evident log.

The AI's only job is turning messy merchant input into structured data. It never
decides anything about money.

---

## Quickstart

```bash
npm install
```

```bash
cp .env.example packages/db/.env
```

```bash
npm run db:generate && npm run db:push
```

```bash
npm test
```

```bash
npm run db:verify
```

```bash
npm run demo
```

`npm test` runs 228 tests: 131 over the pure decision logic, 25 over the AI
structuring gate, and 72 end-to-end
against the real server, the real database and a fake gateway — a human signs a
mandate, a well-behaved agent gets an allow, a rogue agent is blocked five ways,
the payment lifecycle runs through its ugly failure modes, and post-delivery
settlement recommends refunds a human then approves.

`npm run demo` runs the narrated end-to-end story below against a real server
and database. `npm run db:verify` proves the storage half separately: the hash chain links
across real inserts, a signed checkpoint verifies, and the append-only triggers
actually refuse an `UPDATE` and a `DELETE`.

## The demo

`npm run demo` runs seven acts. Nothing is staged — every response printed is
what the HTTP API actually returned.

1. A human signs a mandate. The agent tries to spend against the unsigned draft
   and is refused.
2. The AI reads a messy merchant email and structures it. Every figure had to
   cite verbatim text from that email.
3. Money moves — but only as a hold, with `capture: "manual"` and a checkout
   URL a human completes.
4. The agent goes rogue five ways: over the ceiling, an unapproved SKU, one
   keyboard split across two lines, a merchant email carrying instructions
   aimed at the AI, and an invented price. All five are blocked.
5. Someone edits the mandate in the database. The trigger refuses; then the
   trigger is *dropped* and the signature check catches it anyway.
6. The goods arrive short. The engine recommends a partial refund, the agent
   is refused when it tries to approve its own refund, and a human approves it.
7. The audit log — 30 linked events, verified, and an `UPDATE` refused.

The console (`/console`, served by the API itself) shows the same trail to a
human, and flags when a chain was verified by replay alone rather than against
a signed checkpoint.

## Layout

```
packages/core        every decision that moves money — pure, deterministic, offline
packages/db          Prisma schema, audit repository, append-only guards
packages/adapters    Razorpay and AI structuring (nothing decisive lives here)
apps/api             Fastify service
apps/api/routes/console.ts  the console — one self-contained page, no build step
examples/rogue-agent a demo agent that tries to overspend and gets blocked
```

## The one rule the codebase enforces

`packages/core` holds mandate verification, drift evaluation, capture-deadline
checks, settlement rules, and the audit chain. It may not import an AI SDK, a
network client, the database, the filesystem, `Math.random`, or `Date.now`.
Everything is passed in; a decision is passed back.

This is enforced by ESLint, not by convention:

```bash
npx eslint packages/core/src
```

If that rule ever has to be relaxed, the product's central claim stops being
true — so it is treated as a build failure, not a lint warning.

## Design decisions worth knowing

**Money is `bigint` paise, everywhere.** No floats, no decimals, no rupee
strings in arithmetic. The canonicalizer rejects a non-integer number rather
than rounding it, because a ceiling that rounds is not a ceiling.

**Mandates are hash-bound.** `termsHash = sha256(canonical(terms))`, and the
human's Ed25519 signature covers that hash. Editing a stored mandate breaks the
hash; recomputing the hash breaks the signature. Both cases are tested.

**Verification runs twice** — before authorization and again before capture. A
mandate revoked between the hold and the capture has to be caught, and checking
only once cannot catch it.

**Authorizations use `capture: "manual"`.** Razorpay auto-refunds an
authorized-but-uncaptured payment after 3 days, so 72 hours is a hard ceiling in
the schema, not a tunable. A mandate can ask for less; nothing can ask for more.

**Capture checks its own deadline, synchronously**, in the same transaction that
begins the capture. The background sweeper is cleanup. If the sweeper is dead or
was never deployed, capture still refuses on its own.

**There is no partial release.** An authorized hold has not moved money, so it
can only be reversed in full. Partial amounts are only meaningful after capture.
The state machine makes the wrong version unrepresentable.

**An ambiguous capture is its own state.** A capture that times out has an
unknown outcome — the money may or may not have moved. Retrying risks a double
capture; giving up risks stranding a captured payment. So gateway errors are
classified `retryable` / `terminal` / **`ambiguous`**, anything unrecognised is
ambiguous, and an ambiguous result parks the intent in `capturing` while
reconciliation asks the gateway what actually happened. There is a test where
the fake captures successfully and *then* reports a timeout.

**The AI structures; it never decides.** The model reads messy merchant text
and proposes a candidate. That candidate is then validated against the *same*
`structuredQuoteSchema` a merchant API's response faces, and judged by the same
drift rules against the same signed ceiling. Three things make this real rather
than aspirational: the model must cite a **verbatim source excerpt** for every
figure, checked as a literal substring of the input (a hallucinated price cites
text that isn't there); **abstaining is a first-class answer** and is honoured
rather than retried; and a model that refuses, errors, or is unreachable
produces *no quote at all* — never a guess, never a stale one. Its self-reported
confidence is recorded for audit and gates nothing.

**Settlement recommends; it never pays.** `/settle` produces a recommendation,
`/execute` moves money, and they are separate calls. An agent may only execute
when the *signed mandate* set `autoRefundAllowed` — otherwise a human approves.
The executing caller must confirm the exact recommended amount, so a stale
console tab cannot pay out yesterday's number.

**`escalate` is a real answer.** When the evidence is contradictory — delivered
before it shipped, no tracking, goods that were never quoted — the engine says
so and carries no amount. A rules engine that always produces a number is one
that guesses about somebody's money. Precedence is
`full_refund > escalate > partial_refund > none`, and the reasoning for that
ordering is in `settlement/evaluate.ts`.

**The audit log is append-only and tamper-evident** — not "immutable". Rows can
always be edited by someone with access; what matters is that it is *detectable*.
Each entry hashes the one before it, and periodic Ed25519-signed checkpoints
cover the chain head, so a full rewrite needs the signing key too. There is a
test that demonstrates a bare chain check missing a full rewrite, and the
checkpoint catching it.

## SQLite vs Postgres

SQLite is the MVP default: one file, no setup. Prisma has no `Json` or `String[]`
scalar on SQLite, so structured columns are TEXT holding **canonical** JSON —
which is what gets hashed anyway, so storing the canonical form is the honest
choice rather than a workaround.

To move to Postgres: change the provider and `DATABASE_URL`, then run
`npm run db:push`. The guard SQL has a Postgres twin at
`packages/db/prisma/sql/append_only_guards.postgres.sql` and is applied
automatically.

## Status

- [x] Workspace, tsconfig, `.env.example`, core-purity lint rule
- [x] Core primitives: money, canonical JSON, Ed25519, mandate sign/verify
- [x] Capture deadline + payment lifecycle / reversal rules
- [x] Schema (13 tables) + append-only guards, applied and verified
- [x] Audit hash chain + signed checkpoints, wired to storage
- [x] Drift engine — 17 rules, table-driven, fail-closed
- [x] Mandate + intent + quote + check + audit endpoints
- [x] Razorpay adapter, webhooks, reconciliation, sweeper
- [x] AI structuring adapter (Claude Opus 5, grounded + fail-closed)
- [x] Settlement rules engine + delivery ingestion
- [x] Console + rogue-agent demo
