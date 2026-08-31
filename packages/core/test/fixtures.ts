import { generateEd25519KeyPair } from '../src/crypto.js';
import type { MandateTermsInput } from '../src/mandate/types.js';

export const KEYS = generateEd25519KeyPair();
export const ATTACKER_KEYS = generateEd25519KeyPair();

export const NOW = new Date('2026-08-28T12:00:00.000Z');

/** A realistic mandate: one human, one agent, two SKUs, one merchant. */
export function mandateTermsFixture(
  overrides: Partial<MandateTermsInput> = {},
): MandateTermsInput {
  return {
    version: 1,
    mandateId: '9f1c7a2e-5b3d-4e8a-9c1f-2d6b8e4a0c73',
    nonce: 'b7f3c1a9d2e4486fa0c15d93',
    tenantId: 'tenant_acme',
    principalId: 'user_priya',
    agentId: 'agent_procurement_01',
    currency: 'INR',
    maxAmountPaise: '250000', // ₹2,500.00
    maxCumulativeAmountPaise: '750000', // ₹7,500.00
    maxUses: 3,
    allowedItems: [
      {
        sku: 'SKU-KEYBOARD-MX',
        description: 'Mechanical keyboard, brown switches',
        maxUnitPricePaise: '180000',
        maxQuantity: 1,
      },
      {
        sku: 'SKU-USBC-CABLE-2M',
        maxUnitPricePaise: '60000',
        maxQuantity: 2,
      },
    ],
    allowedMerchantIds: ['merchant_officedepot_in'],
    deliveryWindow: {
      startsAt: '2026-08-29T00:00:00.000Z',
      endsAt: '2026-09-05T00:00:00.000Z',
    },
    notBefore: '2026-08-28T00:00:00.000Z',
    notAfter: '2026-09-04T00:00:00.000Z',
    captureDeadlineHours: 72,
    autoRefundAllowed: false,
    memo: 'Desk setup for the new hire.',
    ...overrides,
  };
}
