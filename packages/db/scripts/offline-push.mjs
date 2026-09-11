/**
 * Offline equivalent of `prisma db push` for SQLite:
 *
 *   1. applies prisma/sql/schema.sqlite.sql via libsql,
 *   2. VERIFIES the applied database against the DMMF derived from
 *      prisma/schema.prisma (every table, column, NOT NULL and index),
 *   3. applies the append-only trigger guards.
 *
 * Exits non-zero on any drift, so a schema change that is not mirrored in the
 * hand-maintained SQL cannot slip through silently.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';

import { createRequire } from 'node:module';

import { createLibSqlClient, loadDotEnv, resolveSqlitePath, schemaDir } from './libsql-client.mjs';

const require = createRequire(import.meta.url);
const schemaWasm = require('@prisma/prisma-schema-wasm');

const here = dirname(fileURLToPath(import.meta.url));
const force = process.argv.includes('--force-reset');

loadDotEnv();
const rawUrl = process.env.DATABASE_URL;
if (!rawUrl) {
  console.error('DATABASE_URL is not set (expected a file: sqlite URL).');
  process.exit(1);
}
const dbPath = resolveSqlitePath(rawUrl);

if (force) {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-journal`, { force: true });
  console.log(`Removed ${dbPath}`);
}

const schemaSql = readFileSync(join(schemaDir, 'sql', 'schema.sqlite.sql'), 'utf8');
const guardsSql = readFileSync(join(schemaDir, 'sql', 'append_only_guards.sql'), 'utf8');
const prismaSchema = readFileSync(join(schemaDir, 'schema.prisma'), 'utf8');

const dmmf = JSON.parse(
  schemaWasm.get_dmmf(
    JSON.stringify({ prismaSchema, env: process.env, ignoreEnvVarErrors: true }),
    'json',
  ),
);

const TYPE_SQL = {
  String: 'TEXT',
  Int: 'INTEGER',
  BigInt: 'BIGINT',
  DateTime: 'DATETIME',
  Boolean: 'BOOLEAN',
};

const client = createLibSqlClient(rawUrl);

await client.executeMultiple(schemaSql);

let failures = 0;
const fail = (message) => {
  console.error(`  DRIFT  ${message}`);
  failures += 1;
};

for (const model of dmmf.datamodel.models) {
  const table = model.dbName ?? model.name;
  const columns = await client.execute({ sql: `PRAGMA table_info("${table}")`, args: [] });
  if (columns.rows.length === 0) {
    fail(`missing table ${table} (model ${model.name})`);
    continue;
  }
  const byName = new Map(columns.rows.map((row) => [String(row.name), row]));

  for (const field of model.fields.filter((f) => f.kind === 'scalar')) {
    const column = byName.get(field.name);
    if (!column) {
      fail(`${table}.${field.name} column missing`);
      continue;
    }
    const expectedType = TYPE_SQL[field.type];
    if (expectedType && String(column.type).toUpperCase() !== expectedType) {
      fail(`${table}.${field.name} is ${column.type}, schema expects ${expectedType}`);
    }
    const required = field.isRequired && !field.hasDefaultValue;
    if (required && Number(column.notnull) !== 1) {
      fail(`${table}.${field.name} should be NOT NULL`);
    }
    if (!field.isRequired && Number(column.notnull) === 1) {
      fail(`${table}.${field.name} should be nullable`);
    }
  }

  const expectedIndexes = new Map();
  for (const field of model.fields.filter((f) => f.isUnique && f.kind === 'scalar')) {
    expectedIndexes.set(JSON.stringify([[field.name], true]), `@unique ${field.name}`);
  }
  if (model.uniqueIndexes) {
    for (const index of model.uniqueIndexes) {
      const fields = index.fields ?? index;
      expectedIndexes.set(JSON.stringify([fields, true]), `@@unique ${fields.join(',')}`);
    }
  }
  if (model.primaryKey?.fields) {
    expectedIndexes.set(JSON.stringify([model.primaryKey.fields, true]), '@@id');
  }
  if (model.isComposite === undefined && model.indexes) {
    for (const index of model.indexes) {
      expectedIndexes.set(
        JSON.stringify([index.fields, false]),
        `@@index ${index.fields.join(',')}`,
      );
    }
  }

  const indexList = await client.execute({ sql: `PRAGMA index_list("${table}")`, args: [] });
  const actualIndexes = new Set();
  for (const row of indexList.rows) {
    const info = await client.execute({
      sql: `PRAGMA index_info("${String(row.name)}")`,
      args: [],
    });
    const fields = info.rows.map((r) => String(r.name));
    actualIndexes.add(JSON.stringify([fields, Number(row.unique) === 1]));
  }
  // SQLite auto-creates a unique index for a single @id primary key.
  const idFields = model.fields.filter((f) => f.isId).map((f) => f.name);
  for (const [key, label] of expectedIndexes) {
    if (!actualIndexes.has(key)) {
      fail(`${table}: index missing for ${label} (${key})`);
    }
  }
  if (idFields.length > 1 && !actualIndexes.has(JSON.stringify([idFields, true]))) {
    fail(`${table}: composite primary key index missing`);
  }
}

await client.executeMultiple(guardsSql);

if (failures > 0) {
  console.error(`\nschema verification failed with ${failures} drift finding(s).`);
  console.error('Update prisma/sql/schema.sqlite.sql to match prisma/schema.prisma.');
  process.exit(1);
}

console.log(`SQLite schema applied and verified at ${dbPath} (${dmmf.datamodel.models.length} models); append-only guards installed.`);
