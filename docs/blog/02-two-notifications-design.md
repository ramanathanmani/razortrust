# Designing an Agent That Pings You Twice, Not Twenty Times — Agents for Humans

*Draft for builder.aws (second bonus post).*

The promise of an "everyday agent" is that it runs quietly in the background.
Most agent demos ping a human on every turn; they feel like autocomplete with
extra steps. While building **Steward**, a Strands Agents SDK procurement agent
for small shops, we arrived at a concrete target: one full restock lifecycle
may surface **exactly two** decisions to the owner. This post is about how the
design gets there.

## Decision inventory before tool design

We listed every moment in the purchase lifecycle where a human adds value:

1. Approving that money leaves the account — after seeing the figures.
2. Approving that money comes back — after seeing what actually arrived.

Everything else is bookkeeping a deterministic system can do better than a
person: structuring a messy quote email, checking it against agreed limits,
placing a hold, capturing an approved hold, recording a delivery, computing
shortages. Those became autonomous tools; the two moments became the only
`decision_required` notifications.

## Why "ask the model" is the wrong gate

If approval policy lives in the prompt, two things go wrong. First, a supplier
email becomes a peer of the prompt — injection text competes on equal footing.
Second, every model swap or temperature change silently changes the safety
boundary. So the Strands agent's tool list simply omits any approval action.
The tools carry requests to a separate deterministic service that evaluates a
signed mandate; a block is a 422 with rule identifiers, which the agent is
instructed to surface verbatim and treat as final.

The system prompt is an *operating procedure* ("open intent, structure, check,
then either request a hold or report the block"). It is never an
*authorization*: there is no sentence the model can say that produces an
approval the service has not already given.

## What silence requires

A quiet agent needs three things that are easy to under-build:

- **Durable memory outside the conversation.** Each mailbox message gets a
  fresh Strands agent. A journal maps quote references to intents and states
  (`quoted → awaiting_approval → captured → settled`), so a crashed or
  restarted worker resumes correctly and never double-works a message.
- **A bounded loop.** The invocation uses `limits.turns`; a model that keeps
  calling tools ends the turn loudly instead of spinning forever.
- **An honest "I can't read this" path.** When the deterministic quote parser
  cannot ground every figure with a verbatim excerpt, the agent escalates as
  `decision_required` rather than estimating. Silence is only acceptable when
  the structured data is complete; guessing is a pinging offense in disguise.

## Notifications are an API, not a chat stream

The outbox records three kinds: `decision_required` (act now), `blocked`
(audit what the agent tried and the rule that refused it), and `handled`
(autonomy the owner can audit later). Decision payloads carry structured
handles — an expiring approval URL, or a settlement id plus the exact refund
amount — so a future mobile notification can deep-link straight to the one
action, instead of dumping a transcript.

The second decision shows the pattern at its strictest: after a short
delivery, the agent computes the partial-refund recommendation, attempts
`execute_refund`, receives a 403 because ordinary mandates require a human, and
*then* raises the decision with the amount pre-filled. The refusal is the
gate, not an error path.

## The test for your own everyday agent

Count the human interruptions in one complete lifecycle of the task you are
automating. If it is more than the number of moments where a human's judgment
genuinely changes the outcome, either the tool surface is missing an
autonomous action, or the agent is asking the model to own a decision it
should be calling an external, deterministic authority for. Steward passes
that test at two — and the owner sleeps through the night.
