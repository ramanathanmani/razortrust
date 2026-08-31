/**
 * Authentication.
 *
 * Both agents and humans present a bearer token and get back an identity scoped
 * to one tenant. That identity is the ONLY thing that decides what the caller
 * can see or do — never an id from the request, which the caller controls.
 *
 * The two paths stay separate on purpose. They have different powers, and
 * merging them is how an agent ends up able to approve its own refund.
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

import { prisma } from '@razortrust/db';
import type { FastifyRequest } from 'fastify';

import { unauthorized } from './errors.js';

export interface AgentIdentity {
  readonly kind: 'agent';
  readonly tenantId: string;
  readonly agentId: string;
  readonly agentName: string;
}

export interface HumanIdentity {
  readonly kind: 'human';
  readonly tenantId: string;
  readonly principalId: string;
}

export type Identity = AgentIdentity | HumanIdentity;

export const KEY_PREFIX = 'rzt_agent_';
export const PRINCIPAL_KEY_PREFIX = 'rzt_principal_';

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** Mint a bearer token. The plaintext is returned once and never stored. */
export function issueToken(prefix: string): { token: string; hash: string; display: string } {
  const token = `${prefix}${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
  return { token, hash: hashApiKey(token), display: token.slice(0, prefix.length + 8) };
}

/** Constant-time compare of two hex digests. */
function digestsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

function bearerFrom(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw unauthorized();
  const token = header.slice('Bearer '.length).trim();
  if (!token) throw unauthorized();
  return token;
}

/**
 * Resolve an agent from its API key.
 *
 * The lookup is by hash, so a stolen database gives an attacker hashes rather
 * than usable keys. The equality check is constant-time even though the index
 * lookup already narrowed it — the cost is negligible and the habit matters.
 */
export async function authenticateAgent(request: FastifyRequest): Promise<AgentIdentity> {
  const token = bearerFrom(request);
  const hash = hashApiKey(token);

  const agent = await prisma.agent.findUnique({
    where: { apiKeyHash: hash },
    select: { id: true, tenantId: true, name: true, status: true, apiKeyHash: true },
  });

  if (!agent) throw unauthorized();

  if (!digestsMatch(agent.apiKeyHash, hash)) throw unauthorized();

  if (agent.status !== 'active') {
    throw unauthorized(`Agent "${agent.name}" is ${agent.status}`);
  }

  return {
    kind: 'agent',
    tenantId: agent.tenantId,
    agentId: agent.id,
    agentName: agent.name,
  };
}

/**
 * Resolve a human principal from a bearer token.
 *
 * Looked up by hash, exactly like an agent. Naming a principal id is not
 * enough to become that principal — the caller has to hold the secret.
 */
export async function authenticatePrincipal(request: FastifyRequest): Promise<HumanIdentity> {
  const token = bearerFrom(request);
  const hash = hashApiKey(token);

  const principal = await prisma.principal.findUnique({
    where: { apiKeyHash: hash },
    select: { id: true, tenantId: true, status: true, apiKeyHash: true },
  });

  if (!principal) throw unauthorized();
  if (!digestsMatch(principal.apiKeyHash, hash)) throw unauthorized();
  if (principal.status !== 'active') throw unauthorized('Principal is not active');

  return { kind: 'human', tenantId: principal.tenantId, principalId: principal.id };
}

/**
 * A token that authenticates as an agent must never pass as a human, and vice
 * versa. Prefixes make that checkable, but the real separation is that the two
 * lookups hit different tables.
 */
export function looksLikePrincipalToken(token: string): boolean {
  return token.startsWith(PRINCIPAL_KEY_PREFIX);
}
