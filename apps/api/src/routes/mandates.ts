/**
 * Mandate endpoints — the human side.
 *
 * The flow is deliberately two-step. `POST /v1/mandates` returns the canonical
 * payload and its hash but activates nothing; the human signs that hash with a
 * key this server never holds, and `POST /:id/activate` submits the signature.
 *
 * That split is the whole point. If this server could produce the signature, a
 * compromised server could mint mandates, and "a human actually approved it"
 * would be a claim rather than a fact.
 */
import { randomUUID } from 'node:crypto';

import {
  canonicalize,
  hashMandateTerms,
  mandateTermsSchema,
  signingEnvelope,
  verifyCanonical,
  verifyMandate,
  type MandateTermsInput,
} from '@razortrust/core';
import { prisma, toCanonicalJson } from '@razortrust/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { authenticatePrincipal } from '../auth.js';
import { audit } from '../audit.js';
import type { Config } from '../config.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';

const activateSchema = z
  .object({
    signature: z.string().min(1),
    signedByPublicKeyPem: z.string().min(1),
  })
  .strict();

const revokeSchema = z.object({ reason: z.string().max(500).optional() }).strict();

/** Shape a stored row into the SignedMandate the core verifier expects. */
function toSignedMandate(row: {
  termsJson: string;
  termsHash: string;
  signature: string | null;
  signedByPublicKeyPem: string | null;
  signedAt: Date | null;
}) {
  return {
    terms: mandateTermsSchema.parse(JSON.parse(row.termsJson)),
    termsHash: row.termsHash,
    signature: row.signature ?? '',
    signedByPublicKeyPem: row.signedByPublicKeyPem ?? '',
    signedAt: row.signedAt?.toISOString() ?? '',
  };
}

export async function mandateRoutes(app: FastifyInstance, config: Config) {
  /**
   * Draft a mandate. Returns what the human must sign.
   *
   * Nothing here can authorise a payment — the mandate is `draft` until a
   * signature arrives.
   */
  app.post('/v1/mandates', async (request, reply) => {
    const identity = await authenticatePrincipal(request);

    const body = request.body as Partial<MandateTermsInput>;

    // The server supplies identity and the anti-replay nonce. Letting the
    // caller choose either would let one principal draft a mandate that names
    // another, or replay a captured signature onto fresh terms.
    const terms = {
      ...body,
      version: 1 as const,
      mandateId: randomUUID(),
      nonce: randomUUID().replace(/-/g, ''),
      tenantId: identity.tenantId,
      principalId: identity.principalId,
    };

    const parsed = mandateTermsSchema.safeParse(terms);
    if (!parsed.success) {
      throw badRequest('Mandate terms are not valid', {
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }

    const agent = await prisma.agent.findFirst({
      where: { id: parsed.data.agentId, tenantId: identity.tenantId },
    });
    if (!agent) throw badRequest(`Agent "${parsed.data.agentId}" does not exist in this tenant`);

    const termsHash = hashMandateTerms(parsed.data);

    await prisma.mandate.create({
      data: {
        id: parsed.data.mandateId,
        tenantId: identity.tenantId,
        principalId: identity.principalId,
        agentId: parsed.data.agentId,
        status: 'draft',
        termsJson: toCanonicalJson(parsed.data),
        termsHash,
        currency: parsed.data.currency,
        maxAmountPaise: parsed.data.maxAmountPaise,
        maxCumulativeAmountPaise: parsed.data.maxCumulativeAmountPaise,
        maxUses: parsed.data.maxUses,
        notBefore: new Date(parsed.data.notBefore),
        notAfter: new Date(parsed.data.notAfter),
      },
    });

    await audit(config, {
      tenantId: identity.tenantId,
      actorType: 'human',
      actorId: identity.principalId,
      eventType: 'mandate.drafted',
      mandateId: parsed.data.mandateId,
      payload: { termsHash },
      occurredAt: new Date().toISOString(),
    });

    return reply.status(201).send({
      mandateId: parsed.data.mandateId,
      status: 'draft',
      termsHash,
      /** Sign THIS, byte for byte, with the principal's Ed25519 key. */
      signingPayload: canonicalize(signingEnvelope(termsHash)),
      terms: JSON.parse(toCanonicalJson(parsed.data)),
    });
  });

  /** Submit the human's signature. This is what makes a mandate spendable. */
  app.post('/v1/mandates/:id/activate', async (request, reply) => {
    const identity = await authenticatePrincipal(request);
    const { id } = request.params as { id: string };

    const parsed = activateSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('signature and signedByPublicKeyPem are required');

    const row = await prisma.mandate.findFirst({ where: { id, tenantId: identity.tenantId } });
    if (!row) throw notFound('Mandate');
    if (row.status !== 'draft') throw conflict(`Mandate is already ${row.status}`);
    if (row.principalId !== identity.principalId) {
      throw forbidden('Only the drafting principal may activate this mandate');
    }

    const principal = await prisma.principal.findUnique({
      where: { id: identity.principalId },
      select: { publicKeyPem: true },
    });

    // The key must be the one on file for this principal. Accepting whatever
    // key the request supplies would make the signature self-certifying and
    // therefore worthless.
    if (!principal || principal.publicKeyPem.trim() !== parsed.data.signedByPublicKeyPem.trim()) {
      throw forbidden('Signing key does not match the key registered for this principal');
    }

    const valid = verifyCanonical(
      signingEnvelope(row.termsHash),
      parsed.data.signature,
      parsed.data.signedByPublicKeyPem,
    );
    if (!valid) {
      await audit(config, {
        tenantId: identity.tenantId,
        actorType: 'human',
        actorId: identity.principalId,
        eventType: 'mandate.verification_failed',
        mandateId: id,
        payload: { reason: 'BAD_SIGNATURE', termsHash: row.termsHash },
        occurredAt: new Date().toISOString(),
      });
      throw forbidden('Signature does not verify against the mandate hash');
    }

    const signedAt = new Date();
    await prisma.mandate.update({
      where: { id },
      data: {
        status: 'active',
        signature: parsed.data.signature,
        signedByPublicKeyPem: parsed.data.signedByPublicKeyPem,
        signedAt,
      },
    });

    await audit(config, {
      tenantId: identity.tenantId,
      actorType: 'human',
      actorId: identity.principalId,
      eventType: 'mandate.activated',
      mandateId: id,
      payload: { termsHash: row.termsHash, signedAt: signedAt.toISOString() },
      occurredAt: signedAt.toISOString(),
    });

    return reply.send({ mandateId: id, status: 'active', termsHash: row.termsHash });
  });

  app.post('/v1/mandates/:id/revoke', async (request, reply) => {
    const identity = await authenticatePrincipal(request);
    const { id } = request.params as { id: string };
    const parsed = revokeSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw badRequest('Invalid revoke payload');

    const row = await prisma.mandate.findFirst({ where: { id, tenantId: identity.tenantId } });
    if (!row) throw notFound('Mandate');

    // Same tenant is not the same person. Only the principal who signed this
    // mandate may withdraw it — otherwise any colleague could cancel someone
    // else's authorisation.
    if (row.principalId !== identity.principalId) {
      throw forbidden('Only the principal who signed this mandate may revoke it');
    }

    if (row.status === 'revoked') return reply.send({ mandateId: id, status: 'revoked' });

    const revokedAt = new Date();
    await prisma.mandate.update({
      where: { id },
      data: { status: 'revoked', revokedAt, revokedReason: parsed.data.reason ?? null },
    });

    await audit(config, {
      tenantId: identity.tenantId,
      actorType: 'human',
      actorId: identity.principalId,
      eventType: 'mandate.revoked',
      mandateId: id,
      payload: { reason: parsed.data.reason ?? null, revokedAt: revokedAt.toISOString() },
      occurredAt: revokedAt.toISOString(),
    });

    // Any authorization already held against this mandate will fail its
    // pre-capture re-check and be released. Revocation is immediate.
    return reply.send({ mandateId: id, status: 'revoked', revokedAt: revokedAt.toISOString() });
  });

  app.get('/v1/mandates/:id', async (request, reply) => {
    const identity = await authenticatePrincipal(request);
    const { id } = request.params as { id: string };

    const row = await prisma.mandate.findFirst({ where: { id, tenantId: identity.tenantId } });
    if (!row) throw notFound('Mandate');

    // Report the verification result alongside the row, so a console can show
    // "signature valid" rather than merely "status: active".
    const verification = row.signature
      ? verifyMandate({
          mandate: toSignedMandate(row),
          state: {
            status: row.status as 'active',
            usesCount: row.usesCount,
            cumulativeAuthorizedPaise: row.cumulativeAuthorizedPaise,
            ...(row.revokedAt ? { revokedAt: row.revokedAt.toISOString() } : {}),
          },
          presentedBy: { tenantId: row.tenantId, agentId: row.agentId },
          now: new Date(),
        })
      : null;

    return reply.send({
      mandateId: row.id,
      status: row.status,
      termsHash: row.termsHash,
      terms: JSON.parse(row.termsJson),
      usesCount: row.usesCount,
      maxUses: row.maxUses,
      cumulativeAuthorizedPaise: row.cumulativeAuthorizedPaise.toString(),
      maxCumulativeAmountPaise: row.maxCumulativeAmountPaise.toString(),
      signedAt: row.signedAt?.toISOString() ?? null,
      revokedAt: row.revokedAt?.toISOString() ?? null,
      verification: verification
        ? verification.ok
          ? { ok: true }
          : { ok: false, failures: verification.failures }
        : { ok: false, failures: [{ code: 'NOT_ACTIVE', message: 'Mandate is not signed yet' }] },
    });
  });
}
