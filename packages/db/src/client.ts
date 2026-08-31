import { PrismaClient } from '../generated/client/index.js';

/**
 * One client for the process. Reused across hot reloads in dev so we do not
 * exhaust connections.
 */
const globalForPrisma = globalThis as unknown as { razortrustPrisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.razortrustPrisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.razortrustPrisma = prisma;
}

export type Db = PrismaClient;
export * from '../generated/client/index.js';
