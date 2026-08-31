/**
 * Proves the storage half of the audit chain against a real database.
 *
 * The unit tests cover the arithmetic; this covers the parts only the database
 * can answer: does the chain link correctly across real inserts, does a signed
 * checkpoint verify, and do the append-only triggers actually refuse an UPDATE?
 *
 * Run: node scripts/verify-setup.mjs
 */
import { randomUUID } from 'node:crypto';

import { generateEd25519KeyPair, verifyChain } from '@razortrust/core';

import { prisma } from '../dist/client.js';
import {
  getAuditEvents,
  recordAuditEvent,
  verifyAuditIntegrity,
  writeCheckpoint,
} from '../dist/audit-repo.js';

const tenantId = `tenant_verify_${randomUUID().slice(0, 8)}`;
const keys = generateEd25519KeyPair();
let failures = 0;

const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

try {
  await prisma.tenant.create({
    data: { id: tenantId, name: 'Verification tenant', auditPublicKeyPem: keys.publicKeyPem },
  });

  console.log('\nAudit chain over real inserts');

  const events = [
    ['mandate.activated', { termsHash: 'abc' }],
    ['intent.created', { merchantId: 'm1' }],
    ['quote.submitted', { totalPaise: '249900' }],
    ['drift.evaluated', { decision: 'allow' }],
    ['authorization.succeeded', { amountPaise: '249900', captureMode: 'manual' }],
  ];

  for (const [eventType, payload] of events) {
    await recordAuditEvent({
      tenantId,
      actorType: 'agent',
      actorId: 'agent_verify',
      eventType,
      payload,
      occurredAt: new Date().toISOString(),
    });
  }

  const stored = await getAuditEvents({ tenantId });
  check('five events appended', stored.length === 5, `got ${stored.length}`);
  check('chain verifies after round-trip through the DB', verifyChain(stored).ok);
  check('first entry anchored to genesis', stored[0]?.prevHash === '0'.repeat(64));
  check(
    'each entry links to the one before it',
    stored.every((e, i) => i === 0 || e.prevHash === stored[i - 1].hash),
  );

  console.log('\nSigned checkpoint');

  const checkpoint = await writeCheckpoint({
    tenantId,
    privateKeyPem: keys.privateKeyPem,
    publicKeyPem: keys.publicKeyPem,
    now: new Date(),
  });
  check('checkpoint written at head', checkpoint?.upToSeq === 5);

  const report = await verifyAuditIntegrity({ tenantId });
  check('integrity verifies from the checkpoint', report.ok && report.mode === 'checkpointed');

  await recordAuditEvent({
    tenantId,
    actorType: 'system',
    actorId: 'sweeper',
    eventType: 'capture.succeeded',
    payload: { amountPaise: '249900' },
    occurredAt: new Date().toISOString(),
  });
  const after = await verifyAuditIntegrity({ tenantId });
  check('still verifies with events appended past the checkpoint', after.ok && after.headSeq === 6);

  console.log('\nAppend-only guards');

  let updateBlocked = false;
  try {
    await prisma.$executeRawUnsafe(
      `UPDATE audit_events SET payloadJson = '{"amountPaise":"1"}' WHERE tenantId = ?`,
      tenantId,
    );
  } catch (err) {
    updateBlocked = String(err).includes('append-only');
  }
  check('UPDATE on audit_events is refused by the trigger', updateBlocked);

  let deleteBlocked = false;
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM audit_events WHERE tenantId = ?`, tenantId);
  } catch (err) {
    deleteBlocked = String(err).includes('append-only');
  }
  check('DELETE on audit_events is refused by the trigger', deleteBlocked);

  const final = await verifyAuditIntegrity({ tenantId });
  check('log survived both attempts intact', final.ok);

  console.log(
    failures === 0
      ? '\nAll storage-layer checks passed.\n'
      : `\n${failures} check(s) failed.\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
} catch (err) {
  console.error('\nVerification aborted:', err);
  process.exitCode = 1;
} finally {
  // audit_events cannot be deleted by design, so the verification tenant is
  // left in place. That is the correct behaviour, not a leak.
  await prisma.$disconnect();
}
