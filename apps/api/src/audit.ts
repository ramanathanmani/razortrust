/**
 * The API's audit helper.
 *
 * Wraps the repository so route handlers cannot forget the checkpoint cadence:
 * every N events, the chain head gets signed. If no signing key is configured
 * the log still appends — it is simply append-only rather than tamper-evident,
 * and config.ts warns about that at boot.
 */
import type { AuditEventInput } from '@razortrust/core';
import { getChainHead, recordAuditEvent, writeCheckpoint } from '@razortrust/db';

import type { Config } from './config.js';

export async function audit(config: Config, event: AuditEventInput): Promise<void> {
  const written = await recordAuditEvent(event);

  if (!config.AUDIT_CHECKPOINT_PRIVATE_KEY_PEM) return;
  if (written.seq % config.AUDIT_CHECKPOINT_EVERY_N_EVENTS !== 0) return;

  await writeCheckpoint({
    tenantId: event.tenantId,
    privateKeyPem: config.AUDIT_CHECKPOINT_PRIVATE_KEY_PEM,
    publicKeyPem: config.AUDIT_CHECKPOINT_PUBLIC_KEY_PEM,
    now: new Date(),
  });
}

/** Force a checkpoint — used on shutdown and by the console's audit view. */
export async function checkpointNow(config: Config, tenantId: string) {
  if (!config.AUDIT_CHECKPOINT_PRIVATE_KEY_PEM) return null;
  const head = await getChainHead(tenantId);
  if (!head) return null;
  return writeCheckpoint({
    tenantId,
    privateKeyPem: config.AUDIT_CHECKPOINT_PRIVATE_KEY_PEM,
    publicKeyPem: config.AUDIT_CHECKPOINT_PUBLIC_KEY_PEM,
    now: new Date(),
  });
}
