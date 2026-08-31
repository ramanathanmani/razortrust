/**
 * The JSON Schema the model's output is constrained to.
 *
 * Written out explicitly rather than derived from the Zod schema, for two
 * reasons. The SDK's Zod helper is typed against Zod v4 while this workspace is
 * on v3, and — more importantly — the schema the model is constrained by and
 * the schema we validate against should be two independent statements. If a
 * generator ever produced a looser JSON Schema than we intended, deriving both
 * from one source would hide that; here, `extractedQuoteSchema` re-checks
 * everything the model returns regardless of what the API enforced.
 *
 * Keep this in step with `extractedQuoteSchema` in types.ts. The test suite
 * asserts they agree on required fields.
 */

export const EXTRACTED_QUOTE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'abstained',
    'abstainReason',
    'currency',
    'merchantQuoteRef',
    'lineItems',
    'subtotalPaise',
    'taxPaise',
    'shippingPaise',
    'discountPaise',
    'totalPaise',
    'totalSourceExcerpt',
    'promisedDeliveryAt',
    'quoteExpiresAt',
    'confidence',
  ],
  properties: {
    abstained: {
      type: 'boolean',
      description:
        'True when the input does not contain a complete, unambiguous final quote. Always prefer abstaining over guessing.',
    },
    abstainReason: {
      type: ['string', 'null'],
      description: 'Why you abstained. Null when abstained is false.',
    },
    currency: { type: 'string', description: 'ISO currency code, e.g. INR.' },
    merchantQuoteRef: {
      type: ['string', 'null'],
      description: "The merchant's own quote reference, if stated.",
    },
    lineItems: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'sku',
          'description',
          'unitPricePaise',
          'quantity',
          'lineTotalPaise',
          'sourceExcerpt',
        ],
        properties: {
          sku: { type: 'string' },
          description: { type: ['string', 'null'] },
          unitPricePaise: {
            type: 'string',
            pattern: '^[0-9]+$',
            description: 'Integer paise as a decimal string. No symbols, separators or decimals.',
          },
          quantity: { type: 'integer', minimum: 0 },
          lineTotalPaise: { type: 'string', pattern: '^[0-9]+$' },
          sourceExcerpt: {
            type: 'string',
            description:
              'A VERBATIM span copied from the input containing this line’s price. Checked as a literal substring; if it is not found, the whole quote is rejected.',
          },
        },
      },
    },
    subtotalPaise: { type: 'string', pattern: '^[0-9]+$' },
    taxPaise: { type: 'string', pattern: '^[0-9]+$' },
    shippingPaise: { type: 'string', pattern: '^[0-9]+$' },
    discountPaise: { type: 'string', pattern: '^[0-9]+$' },
    totalPaise: { type: 'string', pattern: '^[0-9]+$' },
    totalSourceExcerpt: {
      type: 'string',
      description: 'A VERBATIM span copied from the input containing the final total.',
    },
    promisedDeliveryAt: {
      type: 'string',
      description: 'ISO-8601 UTC with milliseconds, e.g. 2026-09-01T00:00:00.000Z',
    },
    quoteExpiresAt: { type: ['string', 'null'] },
    confidence: {
      type: 'integer',
      minimum: 0,
      maximum: 100,
      description: 'Advisory only. Never gates a payment.',
    },
  },
};
