import { describe, expect, it } from 'vitest';

import { DeterministicQuoteStructurer, parseQuoteEmail } from '../src/ai/receipt-parser.js';
import { checkGrounding } from '../src/ai/verify.js';
import { structuredQuoteSchema } from '@razortrust/core';

const EMAIL = `From: orders@officedepot.example
Subject: Your quote Q-88213

  1 x Mechanical Keyboard (MX Brown) [SKU-KEYBOARD-MX] .... Rs 1,750.00
  2 x USB-C Cable 2m [SKU-USBC-CABLE-2M] ................. Rs 500.00 each

  Subtotal: Rs 2,750.00
  Tax:      Rs 200.00
  Shipping: Rs 50.00
  Delivery expected by 2026-09-20T00:00:00.000Z
  Discount: Rs 551.00
  TOTAL:    Rs 2,449.00`;

describe('deterministic quote parser', () => {
  it('parses a standard quote email into a grounded candidate', () => {
    const result = parseQuoteEmail(EMAIL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.extraction.currency).toBe('INR');
    expect(result.extraction.merchantQuoteRef).toBe('Q-88213');
    expect(result.extraction.lineItems).toHaveLength(2);
    expect(result.extraction.lineItems[0]).toMatchObject({
      sku: 'SKU-KEYBOARD-MX',
      unitPricePaise: '175000',
      quantity: 1,
      lineTotalPaise: '175000',
    });
    expect(result.extraction.lineItems[1]).toMatchObject({
      sku: 'SKU-USBC-CABLE-2M',
      unitPricePaise: '50000',
      quantity: 2,
      lineTotalPaise: '100000',
    });
    expect(result.extraction.totalPaise).toBe('244900');
  });

  it('produces excerpts that pass the real verbatim grounding check', () => {
    const result = parseQuoteEmail(EMAIL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const grounding = checkGrounding(result.extraction, EMAIL);
    expect(grounding).toEqual({ grounded: true });
  });

  it('completes the whole structurer path into a valid StructuredQuote', async () => {
    const structurer = new DeterministicQuoteStructurer();
    const outcome = await structurer.structureQuote({
      rawInput: EMAIL,
      merchantId: 'officedepot_x',
      now: new Date('2026-09-10T00:00:00.000Z'),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const parsed = structuredQuoteSchema.safeParse(outcome.quote);
    expect(parsed.success).toBe(true);
    expect(outcome.model).toBe('deterministic-parser');
  });

  it('abstains when there is no total', () => {
    const noTotal = EMAIL.replace(/^\s*TOTAL:.*$/m, '');
    const result = parseQuoteEmail(noTotal);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/total/i);
  });

  it('abstains when no delivery date is promised', () => {
    const noDate = EMAIL.replace(/Delivery expected by .*\n/g, '');
    const result = parseQuoteEmail(noDate);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/delivery date/i);
  });

  it('abstains on a marketing email with no SKU lines', () => {
    const result = parseQuoteEmail('Rs 500 off your next order! Use code SAVE. TOTAL Rs 0.');
    expect(result.ok).toBe(false);
  });

  it('abstains without a recognised currency', () => {
    const result = parseQuoteEmail(
      '1 x Cable [SKU-USBC-CABLE-2M] ..... $5.00\nTOTAL: $5.00\nDelivery by 2026-09-20',
    );
    expect(result.ok).toBe(false);
  });

  it('reads the ₹ symbol and plain-rupee amounts without decimals', () => {
    const email = `1 x Cable [SKU-USBC-CABLE-2M] .... ₹499
Subtotal: ₹499
TOTAL: ₹499
Delivery expected by 2026-09-25T00:00:00.000Z`;
    const result = parseQuoteEmail(email);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extraction.totalPaise).toBe('49900');
  });
});
