/**
 * Audit endpoints.
 *
 * `/verify` is the one that matters: it recomputes the chain from the latest
 * signed checkpoint and reports whether the log is intact. The response says
 * which mode it used, because a `full` verification without a checkpoint is
 * weaker evidence and the caller deserves to know.
 */
import { getAuditEvents, getLatestCheckpoint, verifyAuditIntegrity } from '@razortrust/db';
import type { FastifyInstance } from 'fastify';

import { authenticatePrincipal } from '../auth.js';
import { checkpointNow } from '../audit.js';
import type { Config } from '../config.js';

export async function auditRoutes(app: FastifyInstance, config: Config) {
  app.get('/v1/audit', async (request, reply) => {
    const identity = await authenticatePrincipal(request);
    const query = request.query as { intentId?: string; mandateId?: string; limit?: string };

    const events = await getAuditEvents({
      tenantId: identity.tenantId,
      ...(query.intentId ? { intentId: query.intentId } : {}),
      ...(query.mandateId ? { mandateId: query.mandateId } : {}),
      limit: query.limit ? Math.min(Number(query.limit), 1000) : 200,
    });

    return reply.send({
      count: events.length,
      events: events.map((e) => ({
        seq: e.seq,
        eventType: e.eventType,
        actorType: e.actorType,
        actorId: e.actorId,
        mandateId: e.mandateId ?? null,
        intentId: e.intentId ?? null,
        payload: e.payload,
        prevHash: e.prevHash,
        hash: e.hash,
        occurredAt: e.occurredAt,
      })),
    });
  });

  app.get('/v1/audit/verify', async (request, reply) => {
    const identity = await authenticatePrincipal(request);
    const report = await verifyAuditIntegrity({ tenantId: identity.tenantId });
    const checkpoint = await getLatestCheckpoint(identity.tenantId);

    return reply.status(report.ok ? 200 : 409).send({
      ...report,
      latestCheckpoint: checkpoint
        ? {
            upToSeq: checkpoint.upToSeq,
            headHash: checkpoint.headHash,
            createdAt: checkpoint.createdAt,
          }
        : null,
      note:
        report.ok && report.mode === 'full'
          ? 'Verified by replaying the chain, but no signed checkpoint exists — a full rewrite would not be detected. Configure AUDIT_CHECKPOINT_PRIVATE_KEY_PEM.'
          : undefined,
    });
  });

  app.post('/v1/audit/checkpoint', async (request, reply) => {
    const identity = await authenticatePrincipal(request);
    const checkpoint = await checkpointNow(config, identity.tenantId);
    if (!checkpoint) {
      return reply
        .status(409)
        .send({ error: 'No signing key configured, or nothing new to checkpoint' });
    }
    return reply.status(201).send({
      upToSeq: checkpoint.upToSeq,
      headHash: checkpoint.headHash,
      createdAt: checkpoint.createdAt,
    });
  });
}
