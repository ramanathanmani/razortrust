/**
 * Prisma client factory.
 *
 * The SQLite build runs entirely on Prisma's in-WASM query engine through a
 * libsql driver adapter: no native engine binary has to be downloaded, so the
 * demo installs cleanly behind restrictive firewalls (and on machines without
 * Rust/OpenSSL matching Prisma's prebuilt targets).
 *
 * Postgres remains supported: run a normal `prisma generate` with the native
 * engines and point DATABASE_URL at postgres://…, then import the standard
 * generated client. The offline demo path is sqlite only.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PrismaLibSQL } from '@prisma/adapter-libsql';
import { createClient } from '@libsql/client';

import { PrismaClient } from '../generated/client/wasm.js';

const here = fileURLToPath(new URL('.', import.meta.url));
// compiled layout: packages/db/dist/client.js -> package root is one level up
const packageRoot = dirname(here);
const schemaDir = join(packageRoot, 'prisma');

/**
 * The native Prisma client auto-loads the .env next to the schema; the WASM
 * runtime does not, so mirror that behaviour. Real environment variables win.
 */
function loadDotEnv(): void {
  for (const candidate of [join(packageRoot, '.env'), join(schemaDir, '.env')]) {
    if (!existsSync(candidate)) continue;
    for (const line of readFileSync(candidate, 'utf8').split('\n')) {
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
}
loadDotEnv();

/** Prisma anchors relative sqlite URLs at the schema directory. */
function resolveSqliteUrl(url: string): string {
  const path = url.slice('file:'.length);
  const absolute = isAbsolute(path) ? path : join(schemaDir, path);
  return `file:${absolute}`;
}

function createPrismaClient(): PrismaClient {
  const rawUrl = process.env.DATABASE_URL ?? 'file:./razortrust.db';
  if (!rawUrl.startsWith('file:')) {
    throw new Error(
      `DATABASE_URL ${rawUrl} is not a sqlite URL. The offline/WASM client ` +
        'shipped here supports sqlite only; generate the native client for postgres.',
    );
  }
  const adapter = new PrismaLibSQL(createClient({ url: resolveSqliteUrl(rawUrl) }));
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });
}

/** One client for the process. Reused across hot reloads in dev. */
const globalForPrisma = globalThis as unknown as { razortrustPrisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.razortrustPrisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.razortrustPrisma = prisma;
}

export type Db = PrismaClient;
export * from '../generated/client/wasm.js';
