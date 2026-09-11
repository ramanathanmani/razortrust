-- RazorTrust SQLite schema.
--
-- This is the hand-maintained equivalent of what `prisma db push` generates
-- for prisma/schema.prisma, kept because the offline/WASM toolchain (see
-- scripts/offline-generate.mjs) cannot download the native migration engine.
--
-- scripts/offline-push.mjs applies this file and then VERIFIES it against the
-- DMMF produced from schema.prisma (every model, every column, every index).
-- A schema edit that is not mirrored here fails that check.
--
-- Prisma SQLite conventions used below:
--   String -> TEXT, Int -> INTEGER, BigInt -> BIGINT, DateTime -> DATETIME,
--   Boolean -> BOOLEAN; @default(now()) -> CURRENT_TIMESTAMP; identifiers are
--   quoted; constraint/index names use the MODEL name (not the @@map table).

-- Tenancy -------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "tenants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "auditPublicKeyPem" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "principals" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "publicKeyPem" TEXT NOT NULL,
    "apiKeyHash" TEXT NOT NULL,
    "apiKeyPrefix" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Principal_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Principal_apiKeyHash_key" ON "principals" ("apiKeyHash");
CREATE UNIQUE INDEX IF NOT EXISTS "Principal_tenantId_email_key" ON "principals" ("tenantId", "email");
CREATE INDEX IF NOT EXISTS "Principal_tenantId_idx" ON "principals" ("tenantId");

CREATE TABLE IF NOT EXISTS "agents" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "apiKeyHash" TEXT NOT NULL,
    "apiKeyPrefix" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME,
    CONSTRAINT "Agent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Agent_apiKeyHash_key" ON "agents" ("apiKeyHash");
CREATE INDEX IF NOT EXISTS "Agent_tenantId_idx" ON "agents" ("tenantId");

-- Merchants -----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "merchants" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "externalRef" TEXT NOT NULL,
    "integrationMetadataJson" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Merchant_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Merchant_tenantId_externalRef_key" ON "merchants" ("tenantId", "externalRef");
CREATE INDEX IF NOT EXISTS "Merchant_tenantId_idx" ON "merchants" ("tenantId");

CREATE TABLE IF NOT EXISTS "merchant_api_credentials" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "encryptedSecret" TEXT NOT NULL,
    "encryptionMetaJson" TEXT NOT NULL DEFAULT '{}',
    "expiresAt" DATETIME,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MerchantApiCredential_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "MerchantApiCredential_merchantId_idx" ON "merchant_api_credentials" ("merchantId");

-- Mandates ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "mandates" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "termsJson" TEXT NOT NULL,
    "termsHash" TEXT NOT NULL,
    "signature" TEXT,
    "signedByPublicKeyPem" TEXT,
    "signedAt" DATETIME,
    "currency" TEXT NOT NULL,
    "maxAmountPaise" BIGINT NOT NULL,
    "maxCumulativeAmountPaise" BIGINT NOT NULL,
    "maxUses" INTEGER NOT NULL,
    "notBefore" DATETIME NOT NULL,
    "notAfter" DATETIME NOT NULL,
    "usesCount" INTEGER NOT NULL DEFAULT 0,
    "cumulativeAuthorizedPaise" BIGINT NOT NULL DEFAULT 0,
    "revokedAt" DATETIME,
    "revokedReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Mandate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Mandate_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "principals" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Mandate_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Mandate_tenantId_status_idx" ON "mandates" ("tenantId", "status");
CREATE INDEX IF NOT EXISTS "Mandate_agentId_status_idx" ON "mandates" ("agentId", "status");
CREATE INDEX IF NOT EXISTS "Mandate_termsHash_idx" ON "mandates" ("termsHash");

-- Payment flow --------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "payment_intents" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "mandateId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'created',
    "mandateHashAtCreate" TEXT NOT NULL,
    "mandateHashAtCapture" TEXT,
    "currency" TEXT NOT NULL,
    "requestedAmountPaise" BIGINT,
    "authorizedAmountPaise" BIGINT,
    "capturedAmountPaise" BIGINT,
    "refundedAmountPaise" BIGINT NOT NULL DEFAULT 0,
    "blockedReasonJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PaymentIntent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PaymentIntent_mandateId_fkey" FOREIGN KEY ("mandateId") REFERENCES "mandates" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PaymentIntent_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PaymentIntent_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "PaymentIntent_tenantId_state_idx" ON "payment_intents" ("tenantId", "state");
CREATE INDEX IF NOT EXISTS "PaymentIntent_mandateId_idx" ON "payment_intents" ("mandateId");

CREATE TABLE IF NOT EXISTS "quotes" (
    "id" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "rawInput" TEXT,
    "structuredJson" TEXT NOT NULL,
    "quoteHash" TEXT NOT NULL,
    "totalPaise" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "aiModel" TEXT,
    "aiConfidence" INTEGER,
    "aiRejectedReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Quote_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "payment_intents" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Quote_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Quote_intentId_idx" ON "quotes" ("intentId");

CREATE TABLE IF NOT EXISTS "drift_checks" (
    "id" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "violationsJson" TEXT NOT NULL,
    "rulesVersion" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "evaluatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DriftCheck_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "payment_intents" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DriftCheck_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "quotes" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "DriftCheck_intentId_idx" ON "drift_checks" ("intentId");

CREATE TABLE IF NOT EXISTS "authorizations" (
    "id" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "rzpOrderId" TEXT NOT NULL,
    "rzpPaymentId" TEXT,
    "captureMode" TEXT NOT NULL DEFAULT 'manual',
    "amountPaise" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "method" TEXT,
    "authorizedAt" DATETIME,
    "captureDeadline" DATETIME,
    "capturedAt" DATETIME,
    "releasedAt" DATETIME,
    "releaseReason" TEXT,
    "releaseMethod" TEXT,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Authorization_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "payment_intents" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Authorization_intentId_key" ON "authorizations" ("intentId");
CREATE UNIQUE INDEX IF NOT EXISTS "Authorization_rzpOrderId_key" ON "authorizations" ("rzpOrderId");
CREATE UNIQUE INDEX IF NOT EXISTS "Authorization_rzpPaymentId_key" ON "authorizations" ("rzpPaymentId");
CREATE INDEX IF NOT EXISTS "Authorization_captureDeadline_idx" ON "authorizations" ("captureDeadline");

CREATE TABLE IF NOT EXISTS "approval_tokens" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "usedByIp" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApprovalToken_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "payment_intents" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ApprovalToken_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "principals" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ApprovalToken_tokenHash_key" ON "approval_tokens" ("tokenHash");
CREATE INDEX IF NOT EXISTS "ApprovalToken_intentId_idx" ON "approval_tokens" ("intentId");
CREATE INDEX IF NOT EXISTS "ApprovalToken_expiresAt_idx" ON "approval_tokens" ("expiresAt");

-- Post-delivery -------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "deliveries" (
    "id" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "trackingId" TEXT,
    "carrier" TEXT,
    "status" TEXT NOT NULL,
    "shippedAt" DATETIME,
    "deliveredAt" DATETIME,
    "lineItemsJson" TEXT NOT NULL,
    "rawEvidenceJson" TEXT NOT NULL DEFAULT '{}',
    "source" TEXT NOT NULL DEFAULT 'merchant_api',
    "recordedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Delivery_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "payment_intents" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Delivery_intentId_idx" ON "deliveries" ("intentId");

CREATE TABLE IF NOT EXISTS "settlements" (
    "id" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "deliveryId" TEXT,
    "recommendation" TEXT NOT NULL,
    "refundAmountPaise" BIGINT NOT NULL DEFAULT 0,
    "reasonsJson" TEXT NOT NULL,
    "rulesVersion" TEXT NOT NULL,
    "executedAt" DATETIME,
    "executedBy" TEXT,
    "executedRefundId" TEXT,
    "evaluatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Settlement_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "payment_intents" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Settlement_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "deliveries" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Settlement_intentId_idx" ON "settlements" ("intentId");

CREATE TABLE IF NOT EXISTS "refunds" (
    "id" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "rzpRefundId" TEXT,
    "amountPaise" BIGINT NOT NULL,
    "kind" TEXT NOT NULL,
    "speed" TEXT NOT NULL DEFAULT 'normal',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "initiatedBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" DATETIME,
    CONSTRAINT "Refund_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "payment_intents" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Refund_rzpRefundId_key" ON "refunds" ("rzpRefundId");
CREATE INDEX IF NOT EXISTS "Refund_intentId_idx" ON "refunds" ("intentId");

-- Audit ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "audit_events" (
    "seq" INTEGER NOT NULL,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "mandateId" TEXT,
    "intentId" TEXT,
    "payloadJson" TEXT NOT NULL,
    "prevHash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "occurredAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "AuditEvent_hash_key" ON "audit_events" ("hash");
CREATE UNIQUE INDEX IF NOT EXISTS "AuditEvent_tenantId_seq_key" ON "audit_events" ("tenantId", "seq");
CREATE INDEX IF NOT EXISTS "AuditEvent_tenantId_occurredAt_idx" ON "audit_events" ("tenantId", "occurredAt");
CREATE INDEX IF NOT EXISTS "AuditEvent_intentId_idx" ON "audit_events" ("intentId");
CREATE INDEX IF NOT EXISTS "AuditEvent_mandateId_idx" ON "audit_events" ("mandateId");

CREATE TABLE IF NOT EXISTS "audit_checkpoints" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "upToSeq" INTEGER NOT NULL,
    "headHash" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "signedByPublicKeyPem" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditCheckpoint_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "AuditCheckpoint_tenantId_upToSeq_key" ON "audit_checkpoints" ("tenantId", "upToSeq");
CREATE INDEX IF NOT EXISTS "AuditCheckpoint_tenantId_createdAt_idx" ON "audit_checkpoints" ("tenantId", "createdAt");

-- Infrastructure ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "webhook_events" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'razorpay',
    "providerEventId" TEXT,
    "payloadHash" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "rawBody" TEXT NOT NULL,
    "signatureValid" BOOLEAN NOT NULL,
    "processedAt" DATETIME,
    "processingError" TEXT,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WebhookEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "WebhookEvent_provider_providerEventId_key" ON "webhook_events" ("provider", "providerEventId");
CREATE UNIQUE INDEX IF NOT EXISTS "WebhookEvent_provider_payloadHash_key" ON "webhook_events" ("provider", "payloadHash");
CREATE INDEX IF NOT EXISTS "WebhookEvent_tenantId_receivedAt_idx" ON "webhook_events" ("tenantId", "receivedAt");

CREATE TABLE IF NOT EXISTS "idempotency_keys" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "responseStatus" INTEGER,
    "responseJson" TEXT,
    "intentId" TEXT,
    "lockedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IdempotencyKey_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "IdempotencyKey_tenantId_actorType_actorId_endpoint_key_key" ON "idempotency_keys" ("tenantId", "actorType", "actorId", "endpoint", "key");
CREATE INDEX IF NOT EXISTS "IdempotencyKey_expiresAt_idx" ON "idempotency_keys" ("expiresAt");
