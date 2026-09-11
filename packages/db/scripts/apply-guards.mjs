/**
 * Applies the append-only guard SQL after every schema push.
 *
 * `prisma db push` recreates tables, and recreating a table drops its triggers.
 * So the guards are re-applied every time rather than living in a migration
 * that a push would silently bypass.
 *
 * SQLite path: execute the script raw through libsql (trigger bodies contain
 * semicolons, so naive statement splitting is neither needed nor safe).
 * Postgres path: split on `;` while honouring dollar-quoted function bodies.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLibSqlClient, loadDotEnv } from './libsql-client.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sqlDir = join(here, '..', 'prisma', 'sql');

const isBlank = (s) => !s || s.split('\n').every((l) => !l.trim() || l.trim().startsWith('--'));

function postgresStatements(sql) {
  const out = [];
  let buf = '';
  let inBody = false;
  for (const line of sql.split('\n')) {
    for (const _ of line.match(/\$\$/g) ?? []) inBody = !inBody;
    buf += `${line}\n`;
    if (!inBody && /;\s*$/.test(line)) {
      if (!isBlank(buf)) out.push(buf.trim().replace(/;\s*$/, ''));
      buf = '';
    }
  }
  if (!isBlank(buf)) out.push(buf.trim().replace(/;\s*$/, ''));
  return out;
}

loadDotEnv();
const url = process.env.DATABASE_URL ?? '';
const isPostgres = url.startsWith('postgres');

try {
  if (isPostgres) {
    const { PrismaClient } = await import('../generated/client/index.js');
    const prisma = new PrismaClient();
    const sql = readFileSync(join(sqlDir, 'append_only_guards.postgres.sql'), 'utf8');
    const stmts = postgresStatements(sql);
    for (const stmt of stmts) await prisma.$executeRawUnsafe(stmt);
    await prisma.$disconnect();
    console.log(`Applied ${stmts.length} append-only guard statements (postgres).`);
  } else {
    const client = createLibSqlClient(url);
    const sql = readFileSync(join(sqlDir, 'append_only_guards.sql'), 'utf8');
    await client.executeMultiple(sql);
    console.log('Append-only trigger guards installed (sqlite).');
  }
} catch (err) {
  console.error('Failed to apply append-only guards:', err);
  process.exitCode = 1;
}
