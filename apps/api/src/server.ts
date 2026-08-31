/**
 * The RazorTrust API.
 *
 * Thin on purpose. Routes authenticate, load state, hand plain data to
 * @razortrust/core, and write down what happened. No decision about money is
 * made in this file or in any route handler.
 */
import { prisma } from '@razortrust/db';
import Fastify, { type FastifyInstance } from 'fastify';

import { loadConfig, type Config } from './config.js';
import { ApiError } from './errors.js';
import { getGateway } from './gateway.js';
import { approvalRoutes } from './routes/approve.js';
import { auditRoutes } from './routes/audit.js';
import { overviewRoutes } from './routes/overview.js';
import { consoleRoutes } from './routes/console.js';
import { intentRoutes } from './routes/intents.js';
import { mandateRoutes } from './routes/mandates.js';
import { paymentRoutes } from './routes/payments.js';
import { settlementRoutes } from './routes/settlement.js';
import { webhookRoutes } from './routes/webhooks.js';
import { startSweeper } from './sweeper.js';

export async function buildServer(config: Config): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    // Payment amounts are bigint paise; a body large enough to matter is a bug.
    bodyLimit: 1_048_576,
  });

  /**
   * BigInt does not survive JSON.stringify. Rather than silently losing paise,
   * serialise it as a string — the same representation the schemas accept on
   * the way in, so responses round-trip.
   */
  app.setReplySerializer((payload) => JSON.stringify(payload, bigintReplacer));

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      request.log.info(
        { code: error.code, statusCode: error.statusCode },
        'request rejected by policy',
      );
      return reply.status(error.statusCode).send({
        error: error.code,
        message: error.message,
        ...(error.detail ? { detail: error.detail } : {}),
      });
    }

    request.log.error({ err: error }, 'unhandled error');
    // Fail closed and say nothing useful to an attacker.
    return reply.status(500).send({ error: 'INTERNAL_ERROR', message: 'Something went wrong' });
  });

  app.get('/health', async () => ({
    status: 'ok',
    gateway: getGateway(config).name,
    captureDeadlineHours: config.captureDeadlineHours,
    auditSigning: config.AUDIT_CHECKPOINT_PRIVATE_KEY_PEM ? 'enabled' : 'disabled',
  }));

  await mandateRoutes(app, config);
  await intentRoutes(app, config);
  await paymentRoutes(app, config);
  await settlementRoutes(app, config);
  await auditRoutes(app, config);
  await consoleRoutes(app, config);
  await overviewRoutes(app, config);
  await approvalRoutes(app, config);
  // Registered last: it installs a raw-body parser, scoped to its own context.
  await app.register(async (scope) => webhookRoutes(scope, config));

  return app;
}

function bigintReplacer(_key: string, value: unknown) {
  return typeof value === 'bigint' ? value.toString() : value;
}

async function main() {
  const config = loadConfig();
  const app = await buildServer(config);

  for (const warning of config.warnings) app.log.warn(warning);

  // Cleanup only. Capture guards its own deadline, so this is never load-bearing.
  const stopSweeper = startSweeper({
    config,
    gateway: getGateway(config),
    onError: (err) => app.log.error({ err }, 'sweep failed'),
  });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    stopSweeper();
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
}

// Only run when executed directly, so tests can import buildServer.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
