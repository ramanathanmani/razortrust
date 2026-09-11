/**
 * Shared helpers for the offline DB scripts: resolve DATABASE_URL the same way
 * the Prisma CLI would (relative sqlite paths anchor at the schema directory)
 * and read packages/db/.env when the shell has not exported variables.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClient } from '@libsql/client';

const here = dirname(fileURLToPath(import.meta.url));
export const dbPackageRoot = join(here, '..');
export const schemaDir = join(dbPackageRoot, 'prisma');

export function loadDotEnv() {
  const envFile = join(dbPackageRoot, '.env');
  if (!existsSync(envFile)) return;
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/** Prisma anchors relative sqlite URLs at the schema folder. */
export function resolveSqlitePath(rawUrl) {
  const prefix = 'file:';
  if (!rawUrl?.startsWith(prefix)) throw new Error(`Expected a sqlite file: URL, got ${rawUrl}`);
  let path = rawUrl.slice(prefix.length);
  if (path.startsWith('file:')) path = path.slice('file:'.length); // file:file:… guard
  if (!isAbsolute(path)) path = join(schemaDir, path);
  return path;
}

export function createLibSqlClient(rawUrl = process.env.DATABASE_URL) {
  const path = resolveSqlitePath(rawUrl);
  return createClient({ url: `file:${path}` });
}
