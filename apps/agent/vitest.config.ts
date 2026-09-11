import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    // The e2e suite boots the real server and database. It is gated on an
    // explicit opt-in: the Prisma engine is unavailable in some sandboxes,
    // and CI sets STEWARD_E2E=1 after `prisma db push`.
    exclude: process.env.STEWARD_E2E === '1' ? ['**/node_modules/**'] : ['**/node_modules/**', '**/*.e2e.spec.ts'],
    testTimeout: 30_000,
  },
});
