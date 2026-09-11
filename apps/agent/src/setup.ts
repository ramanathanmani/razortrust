/**
 * Human-side one-time setup (CLI).
 *
 * Provisions the cafe scenario against a running API + database, writes the
 * quote emails into the mailbox directory, and saves TWO files:
 *
 *   .state/context.json  — the agent's file: API URL, its own token, mandate id
 *   .state/human.json    — the owner's file: bearer token and Ed25519 key
 *
 * The agent runtime only ever reads context.json. Splitting them makes the
 * authority boundary visible on disk as well as in the code.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { prisma } from '@razortrust/db';

import { httpRequester } from './inject-client.js';
import { provisionCafeScenario } from './provision.js';

interface Args {
  api: string;
  stateDir: string;
  mailboxDir: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string, fallback: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
  };
  return {
    api: get('--api', process.env.RAZORTRUST_API_ORIGIN ?? 'http://localhost:8080'),
    stateDir: get('--state', new URL('../.state', import.meta.url).pathname),
    mailboxDir: get('--mailbox', new URL('../.state/mailbox', import.meta.url).pathname),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.stateDir, { recursive: true });
  mkdirSync(args.mailboxDir, { recursive: true });

  const requester = httpRequester(args.api);
  const scenario = await provisionCafeScenario(requester);
  const { fixture } = scenario;

  // Only quote mail goes in initially; the delivery note is added after capture.
  const quoteMails = [fixture.messages.validQuote, fixture.messages.overPriceCap, fixture.messages.injectedQuote];
  for (const message of quoteMails) {
    writeFileSync(join(args.mailboxDir, `${message.id}.json`), `${JSON.stringify(message, null, 2)}\n`);
  }
  writeFileSync(
    join(args.stateDir, 'delivery-Q-1001.json.template'),
    `${JSON.stringify(fixture.messages.shortDelivery, null, 2)}\n`,
  );

  writeFileSync(
    join(args.stateDir, 'context.json'),
    `${JSON.stringify(
      {
        apiBaseUrl: args.api,
        tenantId: scenario.tenantId,
        agentId: scenario.agentId,
        agentToken: scenario.agentToken,
        merchantIds: [scenario.merchantId],
        mandateId: scenario.mandateId,
      },
      null,
      2,
    )}\n`,
  );

  writeFileSync(
    join(args.stateDir, 'human.json'),
    `${JSON.stringify(
      {
        apiBaseUrl: args.api,
        principalId: scenario.principalId,
        principalToken: scenario.principalToken,
        keyPair: scenario.keyPair,
      },
      null,
      2,
    )}\n`,
  );

  console.log(`Cafe scenario provisioned against ${args.api}.
  agent file:   ${join(args.stateDir, 'context.json')}
  owner file:   ${join(args.stateDir, 'human.json')}   (NEVER give this to the agent)
  mailbox:      ${args.mailboxDir} (3 quote emails)
  mandate:      ${scenario.mandateId}

Next:
  npm run agent:once     # work the mailbox once and exit
  npm run agent:watch    # work it on an interval (default 60s)
  npm run demo           # the narrated in-process story
`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
