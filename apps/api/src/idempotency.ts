/**
 * Idempotency for money-moving endpoints.
 *
 * Scoped by tenant + actor + endpoint + key, because a bare key column would
 * collide across agents that both use "1", and would treat the same key against
 * two different endpoints as the same operation.
 *
 * The request body is hashed too. Replaying a key with the SAME body returns
 * the original response; replaying it with a DIFFERENT body is a client bug and
 * gets a 409 rather than quietly doing something the caller did not intend.
 */
import { canonicalize, sha256Canonical } from '@razortrust/core';
import { prisma } from '@razortrust/db';
import type { FastifyRequest } from 'fastify';

import { badRequest, conflict } from './errors.js';
import type { Identity } from './auth.js';

/** How long a key is honoured before it may be reused. */
const TTL_MS = 24 * 60 * 60 * 1000;

export interface IdempotencyHit {
  readonly replayed: true;
  readonly status: number;
  readonly body: unknown;
}

export interface IdempotencyMiss {
  readonly replayed: false;
  /** Call once the handler has produced its response. */
  readonly complete: (status: number, body: unknown, intentId?: string) => Promise<void>;
}

export type IdempotencyOutcome = IdempotencyHit | IdempotencyMiss;

function actorOf(identity: Identity) {
  return identity.kind === 'agent'
    ? { actorType: 'agent', actorId: identity.agentId }
    : { actorType: 'human', actorId: identity.principalId };
}

export async function withIdempotency(args: {
  request: FastifyRequest;
  identity: Identity;
  endpoint: string;
  body: unknown;
  /** Required on money-moving endpoints; optional elsewhere. */
  required?: boolean;
}): Promise<IdempotencyOutcome | null> {
  const key = args.request.headers['idempotency-key'];

  if (typeof key !== 'string' || !key) {
    if (args.required) {
      throw badRequest(`Idempotency-Key header is required on ${args.endpoint}`);
    }
    return null;
  }
  if (key.length > 255) throw badRequest('Idempotency-Key must be at most 255 characters');

  const { actorType, actorId } = actorOf(args.identity);
  const requestHash = sha256Canonical(JSON.parse(canonicalize(args.body ?? null)));
  const scope = {
    tenantId: args.identity.tenantId,
    actorType,
    actorId,
    endpoint: args.endpoint,
    key,
  };

  const existing = await prisma.idempotencyKey.findUnique({
    where: { tenantId_actorType_actorId_endpoint_key: scope },
  });

  if (existing && existing.expiresAt > new Date()) {
    if (existing.requestHash !== requestHash) {
      throw conflict(
        'This Idempotency-Key was already used with a different request body',
        { endpoint: args.endpoint },
      );
    }
    if (existing.status === 'completed' && existing.responseJson) {
      return {
        replayed: true,
        status: existing.responseStatus ?? 200,
        body: JSON.parse(existing.responseJson),
      };
    }
    // Still in flight. Two concurrent identical calls: the second waits for the
    // first rather than doubling up on a payment.
    throw conflict('A request with this Idempotency-Key is still in progress');
  }

  const expiresAt = new Date(Date.now() + TTL_MS);

  await prisma.idempotencyKey.upsert({
    where: { tenantId_actorType_actorId_endpoint_key: scope },
    create: { ...scope, requestHash, status: 'in_progress', expiresAt },
    update: { requestHash, status: 'in_progress', expiresAt, responseJson: null, responseStatus: null },
  });

  return {
    replayed: false,
    complete: async (status, body, intentId) => {
      await prisma.idempotencyKey.update({
        where: { tenantId_actorType_actorId_endpoint_key: scope },
        data: {
          status: status < 500 ? 'completed' : 'failed',
          responseStatus: status,
          responseJson: JSON.stringify(body),
          ...(intentId ? { intentId } : {}),
        },
      });
    },
  };
}
