/**
 * Self-contained demo defaults. Importing this module first means the narrated
 * demo (`npm run demo`) works on a fresh checkout without requiring the
 * operator to copy .env files first: it uses the local SQLite database the
 * offline push creates and the deterministic, zero-credits components.
 *
 * Real environment variables always win over these defaults.
 */
process.env.DATABASE_URL ??= 'file:./razortrust.db';
process.env.LOG_LEVEL ??= 'fatal';
process.env.RAZORPAY_KEY_ID ??= '';
process.env.RAZORPAY_KEY_SECRET ??= '';
process.env.RAZORPAY_WEBHOOK_SECRET ??= 'demo_webhook_secret';
process.env.ANTHROPIC_API_KEY ??= '';
process.env.QUOTE_STRUCTURER ??= 'deterministic';
process.env.NODE_ENV ??= 'development';
