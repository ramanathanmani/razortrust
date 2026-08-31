import { Check, ScanSearch, X } from 'lucide-react';

import { formatInstantsInText, formatMoney, formatTimeUtc, type Drift } from '@/lib/api';

/**
 * The verdict panel.
 *
 * It renders the decision the engine already made — the `match` flags come
 * from the violations on the stored verdict, so this table can never disagree
 * with the block that was actually applied.
 */
export function DriftDecision({ drift, currency }: { drift: Drift; currency: string }) {
  const allow = drift.decision === 'allow';

  return (
    <section
      aria-labelledby="drift-heading"
      className="flex min-w-0 flex-col rounded-lg border border-border bg-card"
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <ScanSearch className="size-4 text-muted-foreground" aria-hidden="true" />
        <h2 id="drift-heading" className="text-sm font-semibold">
          Drift Decision
        </h2>
        <span className="ml-auto font-mono text-xs text-muted-foreground">
          checked {formatTimeUtc(drift.evaluatedAt)} UTC
        </span>
      </div>

      <div
        className={`mx-4 mt-4 flex items-center gap-3 rounded-md border px-4 py-3 ${
          allow ? 'border-success/30 bg-success/10' : 'border-destructive/30 bg-destructive/10'
        }`}
      >
        {allow ? (
          <Check className="size-5 shrink-0 text-success" aria-hidden="true" />
        ) : (
          <X className="size-5 shrink-0 text-destructive" aria-hidden="true" />
        )}
        <div>
          <p
            className={`text-lg font-semibold tracking-tight ${
              allow ? 'text-success' : 'text-destructive'
            }`}
          >
            {drift.decision.toUpperCase()}
          </p>
          <p className="text-xs text-muted-foreground">
            Deterministic drift engine · rules {drift.rulesVersion}
            {drift.quoteSource ? ` · ${drift.quoteSource}` : ''}
          </p>
        </div>
      </div>

      <p className="px-4 pt-3 text-sm leading-relaxed text-muted-foreground text-pretty">
        {allow
          ? 'Quote matches mandate on all constrained fields. Price is within ceiling, SKU is in the allowed set, merchant and delivery window match exactly.'
          : drift.violations.map((v) => v.message).join(' · ')}
      </p>

      <div className="overflow-x-auto p-4">
        <table className="w-full min-w-[380px] text-sm">
          <caption className="sr-only">
            Comparison of mandate constraints against the incoming quote
          </caption>
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
              <th scope="col" className="py-2 pr-2 font-medium">Field</th>
              <th scope="col" className="py-2 pr-2 font-medium">Mandate</th>
              <th scope="col" className="py-2 pr-2 font-medium">Quote</th>
              <th scope="col" className="py-2 text-right font-medium">Match</th>
            </tr>
          </thead>
          <tbody>
            {drift.comparison.map((row) => {
              // Money rows arrive as paise and are formatted here; text rows
              // (SKU, merchant, dates) pass through untouched.
              const isMoney = row.field === 'Price';
              const fmt = (v: string | null) => {
                if (v === null) return '—';
                if (!isMoney) return formatInstantsInText(v);
                return v.startsWith('≤ ')
                  ? `≤ ${formatMoney(v.slice(2), currency)}`
                  : formatMoney(v, currency);
              };
              return (
                <tr key={row.field} className="border-b border-border last:border-b-0">
                  <th scope="row" className="py-2.5 pr-2 text-left font-medium text-foreground">
                    {row.field}
                  </th>
                  <td className="py-2.5 pr-2 font-mono text-xs text-muted-foreground">
                    {fmt(row.mandate)}
                  </td>
                  <td className="py-2.5 pr-2 font-mono text-xs">{fmt(row.quote)}</td>
                  <td className="py-2.5 text-right">
                    {row.match ? (
                      <Check className="ml-auto size-4 text-success" aria-label="matches" />
                    ) : (
                      <X className="ml-auto size-4 text-destructive" aria-label="does not match" />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* Rules with no row of their own still blocked the payment. Say so. */}
        {drift.otherViolations.length > 0 && (
          <p className="pt-3 font-mono text-xs text-destructive">
            Also blocked by: {drift.otherViolations.join(', ')}
          </p>
        )}
      </div>
    </section>
  );
}
