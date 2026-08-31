'use client';

import { ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { ChainStatus } from '@/lib/api';

/**
 * The header carries the one claim the whole page exists to support: the chain
 * is intact. It reports whatever the API said — a failed verification turns
 * this red rather than hiding it.
 */
export function TopHeader({ chain, loading }: { chain: ChainStatus | null; loading: boolean }) {
  const [now, setNow] = useState<string | null>(null);

  useEffect(() => {
    // Rendered client-side only: a server-rendered clock would hydrate to a
    // different second and trip a mismatch warning.
    const tick = () => setNow(new Date().toISOString().slice(11, 19));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const verified = chain?.ok === true;
  const tone = loading
    ? 'border-border bg-secondary text-muted-foreground'
    : verified
      ? 'border-success/30 bg-success/10 text-success'
      : 'border-destructive/30 bg-destructive/10 text-destructive';

  return (
    <header className="border-b border-border bg-card/60">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
        <div className="flex items-center gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-secondary">
            <ShieldCheck className="size-4 text-success" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-tight">RazorTrust</h1>
            <p className="text-xs text-muted-foreground text-pretty">
              An AI agent can only pay for what a human actually approved
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          <div
            className="flex items-center gap-1.5 rounded-full border border-border bg-secondary px-2.5 py-1 font-mono text-xs text-muted-foreground"
            aria-live="polite"
          >
            <span className="relative flex size-1.5">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />
              <span className="relative inline-flex size-1.5 rounded-full bg-success" />
            </span>
            <span className="hidden sm:inline">Live · updated</span>
            <span className="sm:hidden">Live</span>
            <time className="text-foreground">{now ? `${now} UTC` : '—'}</time>
          </div>

          <div className={`flex items-center gap-2 rounded-full border px-3 py-1 ${tone}`}>
            <ShieldCheck className="size-3.5" aria-hidden="true" />
            <span className="text-xs font-medium">
              {loading ? 'Checking' : verified ? 'Verified' : 'Chain failed'}
            </span>
          </div>
        </div>
      </div>
    </header>
  );
}
