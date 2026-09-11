import { describe, expect, it } from 'vitest';

import { parseDeliveryNote } from '../src/delivery-parser.js';
import { buildCafeFixture } from '../src/scenarios.js';

describe('parseDeliveryNote', () => {
  it('parses the cafe short-delivery note into settlement evidence', () => {
    const fixture = buildCafeFixture(Date.now(), 'brewline_test');
    const parsed = parseDeliveryNote(fixture.messages.shortDelivery.body);
    expect(parsed).not.toBeNull();
    expect(parsed?.quoteRef).toBe('Q-1001');
    expect(parsed?.evidence.status).toBe('delivered');
    expect(parsed?.evidence.trackingId).toBe('BLR-44012');
    expect(parsed?.evidence.carrier).toBe('BlueDart');
    expect(parsed?.evidence.lineItems).toEqual([
      expect.objectContaining({ sku: 'SKU-CUP-12OZ-50', quantity: 2, condition: 'good' }),
      expect.objectContaining({ sku: 'SKU-COFFEE-HOUSE-1KG', quantity: 1, condition: 'good' }),
    ]);
  });

  it('recognises missing items and damaged conditions', () => {
    const note = `DELIVERY NOTE - order PO-441
Status: delivered
Tracking: CHN-9
Carrier: Delhivery
Shipped: 2026-09-08T09:00:00.000Z
Delivered: 2026-09-10T09:00:00.000Z

0 x SKU-CUP-12OZ-50 missing
1 x SKU-COFFEE-HOUSE-1KG - damaged (torn bag)`;
    const parsed = parseDeliveryNote(note);
    expect(parsed?.evidence.lineItems).toEqual([
      expect.objectContaining({ sku: 'SKU-CUP-12OZ-50', quantity: 0, condition: 'missing' }),
      expect.objectContaining({ sku: 'SKU-COFFEE-HOUSE-1KG', quantity: 1, condition: 'damaged' }),
    ]);
  });

  it('abstains on a note with no quote reference or no status', () => {
    expect(parseDeliveryNote('Just letting you know a parcel showed up.')).toBeNull();
    expect(parseDeliveryNote('Quote ref: Q-1\nsome generic text without a status line')).toBeNull();
  });
});
