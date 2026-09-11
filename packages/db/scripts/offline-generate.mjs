/**
 * Offline `prisma generate` replacement.
 *
 * The standard generator needs the native schema-engine and query-engine
 * binaries downloaded from binaries.prisma.sh. In network-restricted
 * environments those are unreachable, so this drives the same generator with:
 *
 *   1. the Prisma schema WASM that ships on npm (@prisma/prisma-schema-wasm)
 *      to parse the schema into config + DMMF, and
 *   2. the JS generator subprocess bundled in @prisma/client/generator-build.
 *
 * The generated client runs on the in-WASM query engine with a libsql driver
 * adapter (preview "driverAdapters"), so no native binary is needed at runtime
 * either. A placeholder engine file satisfies the generator's copy step; it
 * is deleted afterwards (the WASM engine is what actually runs).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRequire } from 'node:module';

import { dbPackageRoot, loadDotEnv, schemaDir } from './libsql-client.mjs';

const require = createRequire(import.meta.url);
const schemaWasm = require('@prisma/prisma-schema-wasm');

const clientVersion = '5.19.0';
const schemaPath = join(schemaDir, 'schema.prisma');
const prismaSchema = readFileSync(schemaPath, 'utf8');

loadDotEnv();

const schemaInput = JSON.stringify({
  prismaSchema,
  env: process.env,
  ignoreEnvVarErrors: true,
});
const cfgWrapped = JSON.parse(schemaWasm.get_config(schemaInput, 'json'));
if (cfgWrapped.errors?.length) {
  for (const error of cfgWrapped.errors) console.error(error.message ?? error);
  process.exit(1);
}
const gen = cfgWrapped.config.generators.find((g) => g.name === 'client');
if (!gen) throw new Error('schema.prisma is missing the `client` generator');
if (gen.provider.value !== 'prisma-client-js') {
  throw new Error(`offline generator supports prisma-client-js, got ${gen.provider.value}`);
}
if (!(gen.previewFeatures ?? []).includes('driverAdapters')) {
  throw new Error('generator client must set previewFeatures = ["driverAdapters"]');
}

const dmmf = JSON.parse(schemaWasm.get_dmmf(schemaInput, 'json'));
dmmf.version = dmmf.version ?? clientVersion;

const outputPath = resolve(schemaDir, gen.output.value);
const datasources = cfgWrapped.config.datasources.map((ds) => ({
  ...ds,
  url: {
    fromEnvVar: ds.url.fromEnvVar,
    value: process.env[ds.url.fromEnvVar] ?? ds.url.value,
  },
}));

const generatorBuild = require.resolve('@prisma/client/generator-build/index.js');
const child = spawn(process.execPath, [generatorBuild], { stdio: ['pipe', 'inherit', 'pipe'] });

let stderrBuffer = '';
const responses = new Map();
const waiters = new Map();
child.stderr.on('data', (chunk) => {
  stderrBuffer += chunk.toString();
  let newline;
  while ((newline = stderrBuffer.indexOf('\n')) >= 0) {
    const line = stderrBuffer.slice(0, newline).trim();
    stderrBuffer = stderrBuffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      // Node deprecation warnings and friends are not protocol messages.
      continue;
    }
    if (!message.id) continue;
    responses.set(message.id, message);
    waiters.get(message.id)?.(message);
  }
});

const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
const call = (id, method, params) =>
  new Promise((resolveCall, rejectCall) => {
    const existing = responses.get(id);
    if (existing) return settle(existing);
    waiters.set(id, settle);
    send({ jsonrpc: '2.0', id, method, params });
    function settle(message) {
      waiters.delete(id);
      if (message.error) rejectCall(new Error(`${method} failed: ${message.error.message}`));
      else resolveCall(message.result);
    }
  });

await call(1, 'getManifest', { config: { engineType: 'library' } });

// The generator wants a real file path for the native engine copy even when
// the generated client will run on WASM. Give it a throwaway placeholder.
const engineDir = mkdtempSync(join(tmpdir(), 'prisma-engine-'));
const dummyEngine = join(engineDir, 'libquery_engine-placeholder.so.node');
writeFileSync(dummyEngine, 'placeholder (the WASM query engine is used instead)\n');

try {
  await call(2, 'generate', {
    generator: {
      name: gen.name,
      provider: gen.provider,
      output: { fromEnvVar: null, value: outputPath },
      config: gen.config,
      binaryTargets: [{ fromEnvVar: null, value: 'native' }],
      previewFeatures: gen.previewFeatures,
      sourceFilePath: schemaPath,
      isCustomOutput: true,
    },
    otherGenerators: [],
    schemaPath,
    schema: prismaSchema,
    dmmf,
    datasources,
    datamodel: prismaSchema,
    version: clientVersion,
    binaryPaths: { libqueryEngine: { native: dummyEngine } },
    dataProxy: false,
    postinstall: false,
    noEngine: false,
    envPaths: { rootEnvPath: null, schemaEnvPath: join(dbPackageRoot, '.env') },
  });
} finally {
  child.stdin.end();
  child.kill();
}

// The placeholder must not linger in the generated client.
const copiedPlaceholder = join(outputPath, basename(dummyEngine));
if (existsSync(copiedPlaceholder)) rmSync(copiedPlaceholder);

// In plain Node the generated worker loader asks a bundler for `*.wasm?module`,
// which Node cannot import. This loader does the equivalent synchronously from
// disk. The generated runtime then instantiates the WASM query engine itself.
writeFileSync(
  join(outputPath, 'wasm-worker-loader.mjs'),
  `// Generated by scripts/offline-generate.mjs — Node-native replacement for the
// bundler-only \`*.wasm?module\` loader.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bytes = readFileSync(join(here, 'query_engine_bg.wasm'));
const compiled = new WebAssembly.Module(bytes);
export default Promise.resolve({ default: compiled });
`,
);
rmSync(engineDir, { recursive: true, force: true });

console.log(`Prisma client generated (offline, WASM + libsql) to ${outputPath}`);
