/**
 * Steward runtime.
 *
 *   --once                 work the mailbox once, sweep approved holds, exit
 *   --watch                repeat on an interval (default 60s)
 *   --interval <ms>        override the interval
 *   --state <dir>          state directory (default apps/agent/.state)
 *   --model <mode>         scripted (default, zero-credits) or bedrock
 *
 * Requires .state/context.json written by `npm run agent:setup`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { HttpRazorTrustClient } from './api-client.js';
import { runCycle, formatDigest } from './cycle.js';
import { createModel, selectMode, type ModelMode } from './model.js';
import { FileJournal, FileMailbox, FileOutbox } from './state.js';

interface Context {
  apiBaseUrl: string;
  agentToken: string;
  mandateId: string;
  merchantIds: string[];
}

interface RunArgs {
  once: boolean;
  interval: number;
  stateDir: string;
  model?: ModelMode;
}

function parseArgs(argv: string[]): RunArgs {
  const get = (flag: string, fallback?: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
  };
  const args: RunArgs = {
    once: argv.includes('--once'),
    interval: Number(get('--interval', '60000')),
    stateDir: get('--state', new URL('../.state', import.meta.url).pathname)!,
  };
  const model = get('--model');
  if (model) args.model = model as ModelMode;
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mailboxDir = join(args.stateDir, 'mailbox');
  mkdirSync(mailboxDir, { recursive: true });

  const contextPath = join(args.stateDir, 'context.json');
  if (!existsSync(contextPath)) {
    console.error(`No ${contextPath}. Run the setup CLI first (npm run agent:setup).`);
    process.exit(1);
  }
  const context = JSON.parse(readFileSync(contextPath, 'utf8')) as Context;

  const api = new HttpRazorTrustClient({ baseUrl: context.apiBaseUrl, agentToken: context.agentToken });
  const mailbox = new FileMailbox(mailboxDir);
  const outbox = new FileOutbox(args.stateDir);
  const journal = new FileJournal(args.stateDir);
  const model = await createModel(selectMode(args.model));

  const tick = async () => {
    const result = await runCycle({
      model,
      api,
      mailbox,
      outbox,
      journal,
      mandateId: context.mandateId,
      allowedMerchantIds: context.merchantIds,
      sweep: true,
    });
    if (result.notifications.length > 0 || result.processed > 0) {
      console.log(`\n[${new Date().toISOString()}] ${formatDigest(result)}`);
    } else {
      console.log(`[${new Date().toISOString()}] mailbox empty; nothing to do.`);
    }
  };

  await tick();
  if (args.once) {
    process.exit(0);
  }
  setInterval(() => {
    tick().catch((err) => console.error('cycle failed:', err));
  }, args.interval);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
