/**
 * Parse a carrier/merchant delivery note into the evidence shape the
 * settlement engine validates. Same discipline as the quote path: recognise
 * a small, explicit set of conventions, and return `null` (the agent then
 * surfaces the message to the owner) instead of guessing.
 */
export interface ParsedDelivery {
  quoteRef: string;
  evidence: {
    evidenceVersion: 1;
    status: 'in_transit' | 'delivered' | 'failed' | 'returned' | 'lost';
    trackingId?: string;
    carrier?: string;
    shippedAt?: string;
    deliveredAt?: string;
    lineItems: {
      sku: string;
      description?: string;
      quantity: number;
      condition: 'good' | 'damaged' | 'missing';
    }[];
    proofOfDeliveryRef?: string;
  };
}

const STATUS: Record<string, ParsedDelivery['evidence']['status']> = {
  delivered: 'delivered',
  'in transit': 'in_transit',
  in_transit: 'in_transit',
  failed: 'failed',
  returned: 'returned',
  lost: 'lost',
};

export function parseDeliveryNote(body: string): ParsedDelivery | null {
  const ref = /(?:quote|order)\s*(?:ref(?:erence)?)?\s*:?\s*([A-Z0-9][A-Z0-9-]{3,})/i.exec(body);
  const statusMatch = /status\s*:\s*([a-z _]+)/i.exec(body);
  const statusWord = statusMatch?.[1]?.trim().toLowerCase() ?? '';
  const status = STATUS[statusWord];

  if (!ref?.[1] || !status) return null;

  const field = (label: string): string | undefined => {
    const m = new RegExp(`${label}\\s*:\\s*(.+)` , 'i').exec(body);
    return m?.[1]?.trim();
  };

  const iso = (value: string | undefined): string | undefined => {
    if (!value) return undefined;
    const date = /(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?)/.exec(value)?.[1];
    if (!date) return undefined;
    return date.includes('T') ? date : `${date}T00:00:00.000Z`;
  };

  const lineItems: ParsedDelivery['evidence']['lineItems'] = [];
  // `2 x SKU-X ... good` or `1 x SKU-X ... damaged (torn box)` or `0 x SKU-X missing`
  const lineRegex = /^\s*(\d+)\s*x\s+([A-Z0-9][A-Z0-9._-]{2,})(?:\s+[—-]\s*|\s+)?(good|damaged|missing)?/gim;
  for (const match of body.matchAll(lineRegex)) {
    lineItems.push({
      sku: match[2] ?? '',
      quantity: Number(match[1]),
      condition: (match[3]?.toLowerCase() as 'good' | 'damaged' | 'missing') ?? 'good',
    });
  }

  if (status === 'delivered' && lineItems.length === 0) return null;

  const tracking = field('tracking');
  const carrier = field('carrier');
  const shippedAt = iso(field('shipped'));
  const deliveredAt = iso(field('delivered'));
  const proof = field('proof');

  return {
    quoteRef: ref[1],
    evidence: {
      evidenceVersion: 1 as const,
      status,
      ...(tracking ? { trackingId: tracking } : {}),
      ...(carrier ? { carrier } : {}),
      ...(shippedAt ? { shippedAt } : {}),
      ...(deliveredAt ? { deliveredAt } : {}),
      ...(proof ? { proofOfDeliveryRef: proof } : {}),
      lineItems,
    },
  };
}
