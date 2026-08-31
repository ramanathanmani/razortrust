import { FilePenLine } from 'lucide-react';

import { formatDateUtc, formatMoney, type Mandate } from '@/lib/api';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-b border-border py-3 last:border-b-0">
      <dt className="text-xs uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

/** Status chip. A revoked or draft mandate must never read as "Signed". */
function statusChip(m: Mandate) {
  if (m.revokedAt) return { text: 'Revoked', tone: 'border-destructive/30 bg-destructive/10 text-destructive' };
  if (!m.signatureValid) return { text: 'Draft', tone: 'border-warning/40 bg-warning/15 text-warning' };
  if (m.status !== 'active') return { text: m.status, tone: 'border-warning/40 bg-warning/15 text-warning' };
  return { text: 'Signed', tone: 'border-success/30 bg-success/10 text-success' };
}

export function MandatePanel({ mandate }: { mandate: Mandate }) {
  const chip = statusChip(mandate);

  return (
    // min-w-0: a grid item defaults to min-width:auto and will not shrink below
    // its content, so a full-length UUID in a monospace cell would otherwise
    // push the whole page sideways on a phone.
    <section
      aria-labelledby="mandate-heading"
      className="flex min-w-0 flex-col rounded-lg border border-border bg-card"
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <FilePenLine className="size-4 text-muted-foreground" aria-hidden="true" />
          <h2 id="mandate-heading" className="text-sm font-semibold">
            Mandate
          </h2>
        </div>
        <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${chip.tone}`}>
          {chip.text}
        </span>
      </div>

      <dl className="px-4">
        <Row label="Mandate ID">
          <span className="break-all font-mono text-xs text-muted-foreground">{mandate.id}</span>
        </Row>

        <Row label="Price Ceiling">
          <span className="font-mono text-base font-semibold">
            {formatMoney(mandate.maxAmountPaise, mandate.currency)}
          </span>
        </Row>

        <Row label="Allowed SKUs">
          <div className="flex flex-wrap gap-1.5">
            {mandate.allowedSkus.map((sku) => (
              <span
                key={sku}
                className="rounded border border-border bg-secondary px-1.5 py-0.5 font-mono text-xs"
              >
                {sku}
              </span>
            ))}
          </div>
        </Row>

        <Row label="Merchant">
          <span className="break-words">{mandate.allowedMerchants.join(', ')}</span>
        </Row>

        <Row label="Delivery Window">
          <span className="font-mono text-xs">
            {formatDateUtc(mandate.deliveryWindow.startsAt)} →{' '}
            {formatDateUtc(mandate.deliveryWindow.endsAt)}
          </span>
        </Row>

        <Row label="Signed By">{mandate.signedBy}</Row>

        <Row label="Uses">
          <span className="font-mono text-xs">
            {mandate.usesCount} of {mandate.maxUses}
          </span>
        </Row>

        <Row label={mandate.signatureValid ? 'Signature Valid' : 'Signature'}>
          <span
            className={`font-mono text-xs ${
              mandate.signatureValid ? 'text-success' : 'text-warning'
            }`}
          >
            {mandate.signatureValid ? mandate.signatureAlgorithm : 'Not signed yet'}
          </span>
        </Row>
      </dl>
    </section>
  );
}
