/**
 * @razortrust/core — every decision that moves money.
 *
 * This package is pure, deterministic and offline. No AI, no network, no DB,
 * no clock reads. Callers pass data in and get a decision out. The boundary is
 * enforced by ESLint (see eslint.config.mjs) and re-checked in CI, because the
 * entire product claim rests on it.
 */

export * from './money.js';
export * from './canonical.js';
export * from './crypto.js';

export * from './mandate/types.js';
export * from './mandate/hash.js';
export * from './mandate/sign.js';
export * from './mandate/verify.js';

export * from './payment/deadline.js';
export * from './payment/lifecycle.js';

export * from './audit/events.js';
export * from './audit/hashchain.js';

export * from './drift/types.js';
export * from './drift/rules.js';
export * from './drift/evaluate.js';

export * from './settlement/types.js';
export * from './settlement/rules.js';
export * from './settlement/evaluate.js';
