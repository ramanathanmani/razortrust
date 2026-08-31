import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    // The flow test drives one shared database; running files in parallel
    // would have them fighting over the same SQLite file.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
