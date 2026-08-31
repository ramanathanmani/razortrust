import { AlertTriangle, ShieldCheck, Wallet } from 'lucide-react';

import { formatMoney, type Intent, type Settlement } from '@/lib/api';

const LABEL: Record<Settlement['recommendation'], string> = {
  none: 'None',
  partial_refund: 'Partial refund',
  full_refund: 'Full refund',
  escalate: 'Escalate',
};

/**
 * Settlement recommends; it never pays.
 *
 * The chip states who is allowed to act, because that is the fact a human
 * reading this panel actually needs. `autoRefundAllowed` comes from the signed
 * mandate — the console reports it and cannot grant it.
 */
export function SettlementPanel({
  settlement,
  intent,
  currency,
}: {
  settlement: Settlement | null;
  intent: Intent | null;
  currency: string;
}) {
  const escalate = settlement?.recommendation === 'escalate';
  const owed = settlement && settlement.refundAmountPaise !== '0';

  const chip = settlement?.executedAt
    ? { text: 'Executed', tone: 'border-success/30 bg-success/10 text-success', Icon: ShieldCheck }
    : escalate
      ? { text: 'Escalated to a human', tone: 'border-destructive/40 bg-destructive/15 text-destructive', Icon: AlertTriangle }
      : settlement?.autoRefundAllowed && owed
        ? { text: 'Auto-refund permitted', tone: 'border-success/30 bg-success/10 text-success', Icon: ShieldCheck }
        : { text: 'Requires human approval', tone: 'border-warning/40 bg-warning/15 text-warning', Icon: AlertTriangle };

  return (
    <section
      aria-labelledby="settlement-heading"
      className={`flex min-w-0 flex-col overflow-hidden rounded-lg border-2 bg-card shadow-lg ${
        escalate ? 'border-destructive/40' : 'border-border'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3.5 sm:px-5">
        <div className="flex items-center gap-2.5">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-secondary">
            <Wallet className="size-4 text-muted-foreground" aria-hidden="true" />
          </div>
          <h2 id="settlement-heading" className="text-base font-semibold tracking-tight">
            Settlement
          </h2>
        </div>
        <span
          className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${chip.tone}`}
        >
          <chip.Icon className="size-3.5" aria-hidden="true" />
          {chip.text}
        </span>
      </div>

      <div className="grid gap-5 p-4 sm:grid-cols-3 sm:p-5">
        <div>
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Recommendation</p>
          <p
            className={`mt-1.5 text-xl font-semibold tracking-tight ${
              escalate ? 'text-destructive' : ''
            }`}
          >
            {settlement ? LABEL[settlement.recommendation] : 'Not evaluated'}
          </p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Refund Amount</p>
          <p className="mt-1.5 font-mono text-xl font-semibold tracking-tight">
            {formatMoney(settlement?.refundAmountPaise ?? '0', currency)}
          </p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Razorpay Hold</p>
          <p className="mt-1.5 break-all font-mono text-xs text-muted-foreground sm:break-normal">
            {intent?.rzpPaymentId ?? intent?.rzpOrderId ?? '—'}
          </p>
        </div>
      </div>

      <p className="border-t border-border bg-secondary/40 px-4 py-3 text-xs leading-relaxed text-muted-foreground text-pretty sm:px-5">
        {settlement
          ? settlement.reasons.length > 0
            ? settlement.reasons.map((r) => r.message).join(' · ')
            : 'Delivery matched the mandate. Nothing to settle.'
          : 'No delivery has been recorded for this intent yet, so there is nothing to settle.'}
      </p>
    </section>
  );
}
