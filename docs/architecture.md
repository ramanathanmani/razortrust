# RazorTrust + Steward — architecture

## 1. The system at a glance

```mermaid
flowchart LR
    subgraph MerchantWorld[Merchant world — untrusted]
        M1[Supplier emails<br/>quotes, delivery notes]
        GW[Razorpay gateway<br/>fake in demo · real API in prod]
        WH[Razorpay-signed<br/>webhooks]
    end

    subgraph AgentSide[Agent side — holds only an agent token]
        MB[(Mailbox)]
        A["Steward agent<br/>(Strands Agents SDK)<br/>tools + tool loop"]
        J[(Journal)]
        OB[(Decision outbox)]
    end

    subgraph ControlPlane[RazorTrust control plane — deterministic]
        API[Fastify HTTP API]
        RULES[Mandate + drift engine<br/>allow / block, signed terms]
        SETTLE[Settlement rules<br/>refund recommendation]
        AUDIT[Hash-chained audit log<br/>+ signed checkpoints]
        DB[(SQLite / Postgres)]
    end

    subgraph HumanSide[Human side — owner token + signing key]
        H[Owner console]
        LINK[One-time expiring<br/>approval links]
    end

    M1 --> MB --> A
    A -- 12 narrow tools --> API
    API --> RULES --> DB
    API --> SETTLE --> DB
    API --> AUDIT --> DB
    API -->|manual-capture orders| GW
    GW --> WH --> API
    API -->|decision required| OB
    OB --> H
    H -->|completes checkout via gateway| LINK --> GW
    H -->|owner-only: execute refunds| API

    classDef agent fill:#dbeafe,stroke:#2563eb
    classDef ctrl fill:#ecfdf5,stroke:#059669
    classDef human fill:#fef3c7,stroke:#d97706
    class A,MB,J,OB agent
    class API,RULES,SETTLE,AUDIT,DB ctrl
    class H,LINK human
```

The side a credential lives in decides what it can do. The agent's bearer
token can create intents, request holds, and ask for verdicts. The **owner's**
token — plus an Ed25519 private key that never enters the agent process — is
required to activate a mandate, complete checkout, and execute refunds.

## 2. A quote's journey (the money path)

```mermaid
sequenceDiagram
    autonumber
    participant Mail as Mailbox
    participant S as Steward (Strands)
    participant API as RazorTrust API
    participant Rules as Mandate/drift engine
    participant GW as Razorpay
    participant Owner as Owner

    Mail->>S: unread quote email
    S->>API: open_intent (mandateId, merchantId)
    S->>API: structure_quote/from-text
    API->>API: deterministic parser → grounded Zod quote
    S->>API: check_quote
    API->>Rules: terms hash + quote → deterministic verdict
    Rules-->>S: allow (or list of violations)
    alt allow
        S->>API: authorize → manual-capture order + one-time link
        S->>Owner: notify_owner(decision_required, link)
        Owner->>GW: completes checkout on gateway page
        GW->>API: signed payment.authorized webhook
        Note over S: later sweep cycle
        S->>API: list_orders → capture
        API->>Rules: re-verify mandate hash + every rule
        API->>GW: capture (manual)
    else block
        S->>Owner: notify_owner(blocked, rule ids)
        Note over API,GW: no order, no hold, no money
    end
```

Key property: the model chooses the *order of operations and reads the
results*; it never chooses the verdict. `check_quote` and capture-time
re-checks are deterministic functions of the signed mandate and the quote.

## 3. Post-delivery settlement

```mermaid
flowchart TD
    N[Carrier delivery note] --> P[parse line items<br/>abstain if unreadable]
    P --> D[record_delivery — bookkeeping only]
    D --> E[settle — rule engine recommendation<br/>none / partial / full / escalate]
    E --> Q{autoRefundAllowed<br/>in signed mandate?}
    Q -- yes --> AR[agent may execute_refund<br/>exact recommended amount]
    Q -- no --> TRY[agent calls execute_refund anyway]
    TRY -->|403| HUM[notify_owner decision_required<br/>with settlementId + amount]
    HUM --> OV[owner reviews evidence]
    OV -->|confirm exact amount| OE[owner executes refund]
    AR --> LOG[audit chain]
    OE --> LOG
```

A recommendation never moves money. Execution is a separate, authenticated
step, capped at `captured − alreadyRefunded`, and an amount that does not
exactly match the recommendation is rejected.

## 4. Tamper-evident audit

```mermaid
flowchart LR
    E1[event 1<br/>payload canonical JSON] --> H1[hash₁ = H(prev=genesis ‖ payload)]
    H1 --> E2[event 2] --> H2[hash₂ = H(hash₁ ‖ payload₂)]
    H2 --> EN[...] --> HN[hashₙ]
    HN --> CP[checkpoint every N events<br/>Ed25519 signature of head]
    CP --> V[verify route]
    TA[out-of-band public key<br/>trust anchor] --> V
    V -->|signer mismatch / broken link| FAIL[ok: false]
```

- SQLite triggers abort any `UPDATE`/`DELETE` on audit tables.
- Each event's hash covers the canonical payload and the previous hash.
- Checkpoints are Ed25519-signed; `/v1/audit/verify` only accepts checkpoints
  signed by the configured out-of-band public key (`AUDIT_CHECKPOINT_PUBLIC_KEY_PEM`).
  A database attacker cannot forge that signature.

## 5. Strands model swap

```mermaid
flowchart LR
    subgraph Demo[Demo / CI / offline]
        SM[ScriptedModel<br/>implements Strands Model.stream] --> LOOP
    end
    subgraph Prod[Production]
        BM[BedrockModel<br/>Claude on Amazon Bedrock] --> LOOP
    end
    LOOP[Strands Agent tool loop<br/>same 12 tools, same prompt] --> CT[RazorTrust control plane]
```

Both models emit the same stream protocol (tool-use starts, JSON input
deltas, tool results), so behaviour under the deterministic controls is
identical; only the "which tool next" decision changes source.
