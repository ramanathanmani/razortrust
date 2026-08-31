import { Check, ScrollText, ShieldAlert, ShieldCheck } from 'lucide-react';

import {
  eventDetail,
  eventLabel,
  formatTimeUtc,
  isBlockingEvent,
  type AuditEvent,
  type ChainStatus,
} from '@/lib/api';

export function AuditLog({
  events,
  blockedCount,
  chain,
}: {
  events: AuditEvent[];
  blockedCount: number;
  chain: ChainStatus;
}) {
  const verified = chain.ok === true;

  return (
    <section
      aria-labelledby="audit-heading"
      // min-w-0 lets the table scroll inside overflow-x-auto instead of
      // widening the page: a grid item will not shrink below its content
      // without it, so min-w-[560px] on the table would win.
      className="flex min-w-0 flex-col rounded-lg border border-border bg-card"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <ScrollText className="size-4 text-muted-foreground" aria-hidden="true" />
        <h2 id="audit-heading" className="text-sm font-semibold">
          Audit Log
        </h2>
        <div className="ml-auto flex items-center gap-3">
          <span className="text-xs text-muted-foreground">
            {blockedCount} rogue attempt{blockedCount === 1 ? '' : 's'} blocked
          </span>
          <span
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${
              verified
                ? 'border-success/30 bg-success/10 text-success'
                : 'border-destructive/30 bg-destructive/10 text-destructive'
            }`}
          >
            {verified ? (
              <ShieldCheck className="size-3.5" aria-hidden="true" />
            ) : (
              <ShieldAlert className="size-3.5" aria-hidden="true" />
            )}
            {verified ? 'Chain verified' : 'Chain broken'}
          </span>
        </div>
      </div>

      {/*
        A "full" verification without a signed checkpoint is weaker evidence
        than a checkpointed one, and the console says so rather than showing an
        unqualified tick.
      */}
      {verified && chain.mode === 'full' && (
        <p className="border-b border-border bg-warning/5 px-4 py-2 text-xs text-warning">
          Verified by replaying the chain — no signed checkpoint exists yet, so a full rewrite
          would not be detected. Set AUDIT_CHECKPOINT_PRIVATE_KEY_PEM.
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <caption className="sr-only">
            Chronological tamper-evident audit events, newest first
          </caption>
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
              <th scope="col" className="px-4 py-2 font-medium">Time (UTC)</th>
              <th scope="col" className="px-2 py-2 font-medium">Event</th>
              <th scope="col" className="px-2 py-2 font-medium">Detail</th>
              <th scope="col" className="px-2 py-2 font-medium">Hash</th>
              <th scope="col" className="px-4 py-2 text-right font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => {
              const blocking = isBlockingEvent(e.eventType);
              return (
                <tr key={e.seq} className="border-b border-border last:border-b-0">
                  <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-muted-foreground">
                    {formatTimeUtc(e.occurredAt)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2.5">
                    <span
                      className={`rounded border px-1.5 py-0.5 font-mono text-xs ${
                        blocking
                          ? 'border-destructive/30 bg-destructive/10 text-destructive'
                          : 'border-border bg-secondary text-foreground'
                      }`}
                    >
                      {eventLabel(e.eventType)}
                    </span>
                  </td>
                  <td className="min-w-[220px] px-2 py-2.5 text-xs leading-relaxed text-muted-foreground">
                    {eventDetail(e)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2.5 font-mono text-xs text-muted-foreground">
                    {e.hash.slice(0, 8)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-right">
                    <span
                      className={`inline-flex items-center gap-1 text-xs ${
                        blocking ? 'text-destructive' : 'text-success'
                      }`}
                    >
                      {blocking ? (
                        <ShieldAlert className="size-3.5" aria-hidden="true" />
                      ) : (
                        <Check className="size-3.5" aria-hidden="true" />
                      )}
                      {blocking ? 'Blocked' : 'Verified'}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
