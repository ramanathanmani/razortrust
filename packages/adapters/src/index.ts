/**
 * @razortrust/adapters — the outside world.
 *
 * Gateways, HTTP, and (later) the AI structuring client live here. Nothing in
 * this package decides anything about money: it moves money when @razortrust/core
 * says to, and it turns messy external data into validated structures that core
 * can judge.
 */
export * from './razorpay/types.js';
export * from './razorpay/errors.js';
export * from './razorpay/client.js';
export * from './razorpay/fake.js';

export * from './ai/types.js';
export * from './ai/prompt.js';
export * from './ai/verify.js';
export * from './ai/structurer.js';
export * from './ai/fake.js';
