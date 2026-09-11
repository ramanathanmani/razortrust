# Testing a Strands Agent for Real Without Spending a Token — Agents for Humans

*Draft for builder.aws (third bonus post).*

Multi-tool agents are painful to test honestly. Mock the whole loop and you
are testing your mocks; call the real model in CI and tests are slow, flaky,
cost money, and fail the moment an answer is phrased differently. For
**Steward**, a Strands Agents SDK procurement agent, we found a third option:
implement Strands' `Model` interface with a deterministic planner that speaks
the exact same streaming protocol as a hosted model. The full agent — tool
selection, execution, result feedback, turn limits — runs for real, with zero
API credits.

## A model is just an async stream

Strands models implement `stream(messages): AsyncIterable<ModelStreamEvent>`.
Our `ScriptedModel` reads the task brief and the accumulated tool
calls/results from the message history, runs an explicit finite-state
procedure, and emits the same events Bedrock would:

- `modelMessageStartEvent`,
- `modelContentBlockStartEvent` with a `toolUseStart` (tool name + toolUseId),
- `modelContentBlockDeltaEvent` with `toolUseInputDelta` chunks of JSON input,
- `modelContentBlockStopEvent`,
- `modelMessageStopEvent` with `stopReason: 'toolUse'` or `'endTurn'`.

The SDK's agentic loop then does everything it normally does: it validates the
input against the tool's Zod schema, executes the callback, appends a
`toolResultBlock`, and invokes the model again. Bad JSON or a schema violation
is fed back exactly as it would be for Claude. The scripted planner is ~350
lines, auditable by reading, and encodes the same operating procedure the
system prompt gives the hosted model.

## What this makes testable

The hermetic suite (`apps/agent/test/cycle.spec.ts`) uses an in-memory API
double that scripts the *policy verdicts* while reusing the real deterministic
quote parser, then asserts agent behavior end to end:

- three overnight emails produce exactly one approval decision and two rule-based blocks;
- an unreadable email escalates instead of being guessed;
- the sweep captures a human-authorized hold and nothing else;
- a short delivery produces a refund recommendation, an agent `execute_refund`
  attempt, a 403 refusal, and a decision carrying the settlement id;
- when the signed mandate permits auto-refunds, the same flow executes without
  pinging the owner at all.

None of these tests touch a database or the network; the whole file runs in
about a second.

## Don't fake the parts that matter

The deterministic double only replaces the "which tool next" decision. The
money controls stay real: a separate gated suite (`STEWARD_E2E=1`) boots the
actual Fastify service, a real SQLite database, provisions real tenants and a
real signed mandate, and drives the agent over HTTP. It asserts the complete
story, including the signed-checkpoint audit verification. So confidence
comes from two layers: fast, exhaustive tests of the agent's orchestration,
and a small number of slow tests proving the real service enforces what the
agent assumes.

## Production is one variable

Because both models satisfy the same interface, the production swap is
`STEWARD_MODEL=bedrock` with an IAM role allowing `bedrock:InvokeModel` —
agent code, tools, prompts, and tests are unchanged. The deterministic model
also runs the on-stage demo, which means the video can never fail on model
latency or a phrasing change.

If you are building on Strands, writing a scripted `Model` is roughly a day of
work and it changes how the whole team develops agents: every edge case
becomes a regression test, the demo always works, and the token bill for
"did the agent do the right thing?" becomes zero.
