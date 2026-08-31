/**
 * Configuration, validated once at boot.
 *
 * Anything the safety story depends on is checked here rather than at the call
 * site. A capture deadline configured beyond Razorpay's 3-day auto-refund
 * would be a silent liability, so it is clamped and reported.
 */
import { MAX_CAPTURE_DEADLINE_HOURS } from '@razortrust/core';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().min(1),

  RAZORPAY_KEY_ID: z.string().default(''),
  RAZORPAY_KEY_SECRET: z.string().default(''),
  RAZORPAY_WEBHOOK_SECRET: z.string().default(''),

  CAPTURE_DEADLINE_HOURS: z.coerce.number().int().positive().default(72),

  AUDIT_CHECKPOINT_PRIVATE_KEY_PEM: z.string().default(''),
  AUDIT_CHECKPOINT_PUBLIC_KEY_PEM: z.string().default(''),
  AUDIT_CHECKPOINT_EVERY_N_EVENTS: z.coerce.number().int().positive().default(100),

  ANTHROPIC_API_KEY: z.string().default(''),
  ANTHROPIC_MODEL: z.string().default('claude-opus-5'),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Invalid configuration:\n  ${detail}`);
  }

  const raw = parsed.data;
  const captureDeadlineHours = Math.min(raw.CAPTURE_DEADLINE_HOURS, MAX_CAPTURE_DEADLINE_HOURS);

  const warnings: string[] = [];
  if (raw.CAPTURE_DEADLINE_HOURS > MAX_CAPTURE_DEADLINE_HOURS) {
    warnings.push(
      `CAPTURE_DEADLINE_HOURS=${raw.CAPTURE_DEADLINE_HOURS} exceeds the Razorpay 3-day ceiling; clamped to ${MAX_CAPTURE_DEADLINE_HOURS}.`,
    );
  }
  if (!raw.AUDIT_CHECKPOINT_PRIVATE_KEY_PEM) {
    warnings.push(
      'AUDIT_CHECKPOINT_PRIVATE_KEY_PEM is unset: the audit log will be append-only but NOT signed. ' +
        'Generate a key before any deployment you intend to trust.',
    );
  }
  if (raw.NODE_ENV === 'production' && !raw.RAZORPAY_KEY_SECRET) {
    throw new Error('RAZORPAY_KEY_SECRET is required in production');
  }

  return { ...raw, captureDeadlineHours, warnings } as const;
}
