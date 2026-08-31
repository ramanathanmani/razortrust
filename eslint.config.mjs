// @ts-check
import tseslint from 'typescript-eslint';

/**
 * The single most important rule in this repo lives here.
 *
 * packages/core holds every decision that moves money: mandate verification,
 * drift evaluation, capture-deadline checks, settlement rules, the audit hash
 * chain. It must stay pure, deterministic and offline. An AI model may never
 * be in that call path, and neither may the network — otherwise "plain code
 * decides all money movement" is a claim we cannot defend.
 *
 * This is enforced here and re-checked in CI.
 */
const AI_AND_NETWORK_BAN = {
  patterns: [
    {
      group: [
        '@anthropic-ai/*',
        'openai',
        'openai/*',
        '@google/*',
        'langchain',
        'langchain/*',
        '@langchain/*',
        'ollama',
        '@razortrust/adapters',
        '@razortrust/adapters/*',
        '@razortrust/db',
        '@razortrust/db/*',
        'razorpay',
        'razorpay/*',
        'axios',
        'node-fetch',
        'undici',
        'got',
        'http',
        'https',
        'node:http',
        'node:https',
        'net',
        'node:net',
        'dns',
        'node:dns',
        'child_process',
        'node:child_process',
        'fs',
        'node:fs',
        'node:fs/promises',
      ],
      message:
        'packages/core must stay pure and deterministic: no AI SDKs, no network, no I/O, no DB. ' +
        'Move this into packages/adapters or apps/api and pass plain data into core.',
    },
  ],
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/coverage/**',
      'packages/db/generated/**',
      // The Next.js console lints through `next lint` with its own rules; the
      // root config has no React or JSX plugins and would only produce noise.
      'apps/web/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', AI_AND_NETWORK_BAN],
      // packages/adapters is where network access belongs; core is where it
      // must never appear.
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Network access does not belong in decision code.' },
      ],
      // Non-determinism leaks into decisions through these. Core takes an
      // explicit `now` / `nonce` argument instead.
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'Core must be deterministic. Pass randomness in as an argument.',
        },
        {
          object: 'Date',
          property: 'now',
          message: 'Core must be deterministic. Pass `now` in as an argument.',
        },
      ],
      'no-console': 'error',
    },
  },
  {
    files: ['packages/core/test/**/*.ts'],
    rules: { 'no-restricted-properties': 'off', 'no-console': 'off' },
  },
);
