# Deploying Steward

Steward is a headless background worker (it polls a mailbox on an interval);
RazorTrust is the service it calls; the web console is optional. This guide
covers running them as processes, in containers, and what changes for
**AWS AgentCore**.

## Components

| Process | Start command | State |
| --- | --- | --- |
| API (deterministic control plane) | `npm run dev:api` (dev) / `node apps/api/dist/server.js` | SQLite file or Postgres |
| Steward worker | `npm run agent:watch` | `apps/agent/.state` (mailbox, journal, outbox, tokens) |
| Setup (one-shot) | `npm run agent:setup -- --api https://api.example.com` | writes `.state/context.json` and `.state/human.json` |
| Console (optional) | `npm run dev:web` | none, talks to the API |

## Environment

**API** (see `.env.example`, copied to `packages/db/.env`):

- `DATABASE_URL` — sqlite `file:…` (default) or a Postgres URL (use the native
  Prisma client for Postgres; the offline/WASM client ships for sqlite only).
- `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` — gateway credentials. Leave blank
  with the fake gateway for demos.
- `RAZORPAY_WEBHOOK_SECRET` — webhook HMAC verification.
- `QUOTE_STRUCTURER` — `deterministic` (default-safe) or `anthropic`.
- `AUDIT_CHECKPOINT_PRIVATE_KEY_PEM` / `AUDIT_CHECKPOINT_PUBLIC_KEY_PEM` —
  Ed25519 keypair. The public key is the out-of-band trust anchor; keep the
  private key in a secret manager. If unset, the chain stays append-only but is
  not signed (the verify endpoint says so).
- `AUDIT_CHECKPOINT_EVERY_N_EVENTS` — checkpoint cadence (default 100).

**Steward worker**:

- `STEWARD_MODEL` — `scripted` (default, zero-credits) or `bedrock`.
- `STEWARD_BEDROCK_MODEL`, `AWS_REGION` — for Bedrock.
- `--interval <ms>` — mailbox polling interval (default 60000).
- `.state/context.json` and `.state/human.json` are produced by the setup CLI.
  Only `context.json` (the agent token) belongs in the worker's filesystem.

## Container layout

A minimal container for the API:

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY . .
RUN npm ci || npm install
RUN npm run db:generate && npm run build
ENV DATABASE_URL="file:/data/razortrust.db"
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "apps/api/dist/server.js"]
```

Run `npm run db:push` against the volume once (init job), then run the same
image with `node apps/agent/dist/run.js --watch --state /state` for the worker,
after `node apps/agent/dist/setup.js --api https://api:8080` has provisioned
the scenario and written `/state`. Mount `/state` and `/data` on persistent
volumes; never put `human.json` on the worker.

## AWS AgentCore mapping

AgentCore runs containerized, Strands-based agents with AWS IAM auth. The
mapping is intentionally clean because Steward already holds no payment
instrument and treats every money decision as an external API call:

1. **Runtime**: run the worker image above on AgentCore; the Strands
   integration is unmodified (`apps/agent/src/agent.ts` + `cycle.ts`).
2. **Model**: set `STEWARD_MODEL=bedrock` and attach an IAM role with
   `bedrock:InvokeModel` (and `bedrock:InvokeModelWithResponseStream`) on the
   configured model id.

   ```json
   {
     "Effect": "Allow",
     "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
     "Resource": ["arn:aws:bedrock:*:*:inference-profile/*", "arn:aws:bedrock:*:*:model/*"]
   }
   ```

3. **Transport**: in production, swap the file mailbox/outbox (`state.ts`) for
   SES/SQS-backed implementations of the same `Mailbox`/`Outbox` interfaces —
   the agent loop and tools do not change.
4. **Secrets**: the owner token/signing key and checkpoint private key belong
   in Secrets Manager (or KMS-wrapped secrets), not the image.
5. **Persistence**: point `DATABASE_URL` at a managed Postgres and generate
   the native Prisma client for that deploy; the API and the setup job run
   against the same database.

## Observability and safety operations

- `GET /v1/audit/verify` (principal token) reports chain integrity and whether
  verification was anchored on a signed checkpoint.
- Revoke a mandate at any time: capture-time re-verification fails and the
  sweeper cannot capture the hold.
- Delete the worker's `context.json` agent token record to stop the agent;
  delete the principal token to stop refunds.
