/**
 * Applies the append-only guard SQL after every schema push.
 *
 * `prisma db push` recreates tables, and recreating a table drops its triggers.
 * So the guards are re-applied every time rather than living in a migration
 * that a push would silently bypass.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PrismaClient } from '../generated/client/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const url = process.env.DATABASE_URL ?? '';
const isPostgres = url.startsWith('postgres');

const sqlFile = join(
  here,
  '..',
  'prisma',
  'sql',
  isPostgres ? 'append_only_guards.postgres.sql' : 'append_only_guards.sql',
);

const isBlank = (s) => !s || s.split('\n').every((l) => !l.trim() || l.trim().startsWith('--'));

/**
 * Split a guard file into executable statements.
 *
 * Naive splitting on `;` does not work here: a SQLite trigger body is
 * `BEGIN ... ; ... END;`, and a Postgres function body is `$$ ... ; ... $$`.
 * Both carry semicolons that are not statement terminators, so the splitter
 * has to know where a body starts and ends.
 */
function statements(sql) {
  if (isPostgres) {
    // Toggle on each `$$`; only split on `;` while outside a dollar-quoted body.
    const out = [];
    let buf = '';
    let inBody = false;
    for (const line of sql.split('\n')) {
      for (const _ of line.match(/\$\$/g) ?? []) inBody = !inBody;
      buf += line + '\n';
      if (!inBody && /;\s*$/.test(line)) {
        if (!isBlank(buf)) out.push(buf.trim().replace(/;\s*$/, ''));
        buf = '';
      }
    }
    if (!isBlank(buf)) out.push(buf.trim().replace(/;\s*$/, ''));
    return out;
  }

  const out = [];
  let buf = '';
  let inTriggerBody = false;
  for (const line of sql.split('\n')) {
    buf += line + '\n';
    const trimmed = line.trim();

    if (!inTriggerBody && /\bBEGIN\s*$/i.test(trimmed)) {
      inTriggerBody = true;
      continue;
    }
    if (inTriggerBody) {
      // Only a bare `END;` closes the body — the `;` inside it does not.
      if (/^END\s*;/i.test(trimmed)) {
        inTriggerBody = false;
        if (!isBlank(buf)) out.push(buf.trim().replace(/;\s*$/, ''));
        buf = '';
      }
      continue;
    }
    if (/;\s*$/.test(trimmed)) {
      if (!isBlank(buf)) out.push(buf.trim().replace(/;\s*$/, ''));
      buf = '';
    }
  }
  if (!isBlank(buf)) out.push(buf.trim().replace(/;\s*$/, ''));
  return out;
}

const prisma = new PrismaClient();

try {
  const sql = readFileSync(sqlFile, 'utf8');
  const stmts = statements(sql);

  for (const stmt of stmts) {
    await prisma.$executeRawUnsafe(stmt);
  }

  console.log(
    `Applied ${stmts.length} append-only guard statements from ${isPostgres ? 'postgres' : 'sqlite'} guard file.`,
  );
} catch (err) {
  console.error('Failed to apply append-only guards:', err);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
