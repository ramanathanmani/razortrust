/**
 * Choosing a gateway.
 *
 * The fake is used when no Razorpay credentials are configured, so the full
 * lifecycle — authorize, capture, release, webhooks, reconciliation — is
 * exercisable with no network and no account. It is never selected silently in
 * production: config.ts already refuses to boot there without a key secret.
 */
import {
  AnthropicQuoteStructurer,
  FakeGateway,
  FakeQuoteStructurer,
  RazorpayGateway,
  type PaymentGateway,
  type QuoteStructurer,
} from '@razortrust/adapters';

import type { Config } from './config.js';

let singleton: PaymentGateway | null = null;
let structurerSingleton: QuoteStructurer | null = null;

export function buildGateway(config: Config): PaymentGateway {
  if (config.RAZORPAY_KEY_ID && config.RAZORPAY_KEY_SECRET) {
    return new RazorpayGateway({
      keyId: config.RAZORPAY_KEY_ID,
      keySecret: config.RAZORPAY_KEY_SECRET,
      webhookSecret: config.RAZORPAY_WEBHOOK_SECRET,
    });
  }
  return new FakeGateway(config.RAZORPAY_WEBHOOK_SECRET || 'fake_webhook_secret');
}

/** One instance per process, so the fake's in-memory state is shared. */
export function getGateway(config: Config): PaymentGateway {
  singleton ??= buildGateway(config);
  return singleton;
}

/** Tests reach for this to drive the fake directly. */
export function asFakeGateway(gateway: PaymentGateway): FakeGateway {
  if (!(gateway instanceof FakeGateway)) {
    throw new Error('Gateway is not the fake; cannot inject faults');
  }
  return gateway;
}

export function resetGateway(): void {
  singleton = null;
  structurerSingleton = null;
}

/**
 * The AI structurer.
 *
 * Falls back to the deterministic fake when no API key is configured, so the
 * whole flow stays runnable offline. The fake abstains by default rather than
 * inventing a quote — an absent model must never become a permissive one.
 */
export function getStructurer(config: Config): QuoteStructurer {
  structurerSingleton ??= config.ANTHROPIC_API_KEY
    ? new AnthropicQuoteStructurer({
        apiKey: config.ANTHROPIC_API_KEY,
        model: config.ANTHROPIC_MODEL,
      })
    : new FakeQuoteStructurer();
  return structurerSingleton;
}

export function asFakeStructurer(structurer: QuoteStructurer): FakeQuoteStructurer {
  if (!(structurer instanceof FakeQuoteStructurer)) {
    throw new Error('Structurer is not the fake; cannot queue extractions');
  }
  return structurer;
}
