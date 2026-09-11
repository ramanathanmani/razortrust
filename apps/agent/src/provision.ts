/**
 * One-time human-side provisioning for a scenario: tenant, the human
 * principal (with an Ed25519 signing key), the agent identity, the merchant,
 * and a signed mandate.
 *
 * The split between what comes back here matters for the demo: the agent's
 * runtime context contains only its own token and the mandate id. The human's
 * bearer token and signing key live in a separate file the agent never reads.
 */
import { hashApiKey } from '@razortrust/api';
import { generateEd25519KeyPair, signCanonical, signingEnvelope } from '@razortrust/core';
import { prisma } from '@razortrust/db';
import { randomUUID } from 'node:crypto';

import { buildCafeFixture, newRunId, type CafeFixture } from './scenarios.js';
import type { RawRequestFn } from './inject-client.js';

export interface ProvisionedScenario {
  fixture: CafeFixture;
  tenantId: string;
  principalId: string;
  agentId: string;
  merchantId: string;
  mandateId: string;
  agentToken: string;
  /** Human-only. The agent runtime must never be handed this. */
  principalToken: string;
  /** Human-only Ed25519 key pair. */
  keyPair: { publicKeyPem: string; privateKeyPem: string };
}

export async function provisionCafeScenario(
  request: RawRequestFn,
  now: number = Date.now(),
): Promise<ProvisionedScenario> {
  const run = newRunId();
  const tenantId = `cafe_${run}`;
  const principalId = `owner_${run}`;
  const agentId = `steward_${run}`;
  const merchantId = `brewline_${run}`;

  const agentToken = `rzt_agent_${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
  const principalToken = `rzt_principal_${randomUUID().replace(/-/g, '')}${randomUUID()
    .replace(/-/g, '')}`;
  const keyPair = generateEd25519KeyPair();

  const fixture = buildCafeFixture(now, merchantId);

  await prisma.tenant.create({ data: { id: tenantId, name: 'Brew & Bean Cafe (demo)' } });
  await prisma.principal.create({
    data: {
      id: principalId,
      tenantId,
      name: 'Cafe Owner',
      publicKeyPem: keyPair.publicKeyPem,
      apiKeyHash: hashApiKey(principalToken),
      apiKeyPrefix: principalToken.slice(0, 22),
    },
  });
  await prisma.agent.create({
    data: {
      id: agentId,
      tenantId,
      name: 'Steward — supplies reorder agent',
      apiKeyHash: hashApiKey(agentToken),
      apiKeyPrefix: agentToken.slice(0, 16),
    },
  });
  await prisma.merchant.create({
    data: {
      id: `m_${run}`,
      tenantId,
      displayName: 'Brewline Supplies',
      externalRef: merchantId,
    },
  });

  // Human signs the mandate: draft, sign the exact canonical envelope, activate.
  const draft = await request({
    method: 'POST',
    path: '/v1/mandates',
    token: principalToken,
    payload: { agentId, ...fixture.mandateTerms },
  });
  if (!draft.ok) throw new Error(`Mandate draft failed: ${JSON.stringify(draft.body)}`);

  const mandateId = draft.body.mandateId as string;
  const termsHash = draft.body.termsHash as string;
  const signature = signCanonical(signingEnvelope(termsHash), keyPair.privateKeyPem);

  const activated = await request({
    method: 'POST',
    path: `/v1/mandates/${mandateId}/activate`,
    token: principalToken,
    payload: { signature, signedByPublicKeyPem: keyPair.publicKeyPem },
  });
  if (!activated.ok) throw new Error(`Mandate activation failed: ${JSON.stringify(activated.body)}`);

  return {
    fixture,
    tenantId,
    principalId,
    agentId,
    merchantId,
    mandateId,
    agentToken,
    principalToken,
    keyPair,
  };
}
