'use client';

import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { AuditLog } from '@/components/audit-log';
import { DriftDecision } from '@/components/drift-decision';
import { MandatePanel } from '@/components/mandate-panel';
import { SettlementPanel } from '@/components/settlement-panel';
import { TokenGate } from '@/components/token-gate';
import { TopHeader } from '@/components/top-header';
import {
  ApiError,
  clearToken,
  fetchOverview,
  readToken,
  writeToken,
  type Overview,
} from '@/lib/api';

/** Refresh cadence. Slow enough to be free, fast enough to feel live. */
const POLL_MS = 10_000;

export default function ConsolePage() {
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);

  // sessionStorage is not available during SSR, so the token is read after mount.
  useEffect(() => {
    setToken(readToken());
    setReady(true);
  }, []);

  const load = useCallback(
    async (t: string, opts: { showSpinner?: boolean } = {}) => {
      if (opts.showSpinner) setLoading(true);
      try {
        setData(await fetchOverview(t));
        setError(null);
      } catch (err) {
        const apiErr =
          err instanceof ApiError ? err : new ApiError(0, 'Something went wrong loading the console.');
        setError(apiErr);
        // A rejected token is not a transient failure — drop it and re-gate,
        // rather than polling a credential the API has already refused.
        if (apiErr.isAuth) {
          clearToken();
          setToken(null);
          setData(null);
        }
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!token) return;
    void load(token, { showSpinner: true });
    const id = setInterval(() => void load(token), POLL_MS);
    return () => clearInterval(id);
  }, [token, load]);

  // Avoid rendering the gate for a frame before sessionStorage has been read.
  if (!ready) return <div className="min-h-dvh bg-background" />;

  if (!token) {
    return (
      <TokenGate
        error={error?.isAuth ? error.message : undefined}
        onSubmit={(t) => {
          writeToken(t);
          setError(null);
          setToken(t);
        }}
      />
    );
  }

  const currency = data?.mandate?.currency ?? 'INR';

  return (
    <div className="flex min-h-dvh flex-col">
      <TopHeader chain={data?.chain ?? null} loading={loading && !data} />

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-5 sm:px-6 sm:py-6">
        {/* A transport failure must be visible. Stale panels stay on screen
            underneath so a blip does not blank the whole console. */}
        {error && !error.isAuth && (
          <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3">
            <AlertTriangle className="size-4 shrink-0 text-destructive" aria-hidden="true" />
            <p className="text-sm text-destructive">{error.message}</p>
            <button
              type="button"
              onClick={() => void load(token, { showSpinner: true })}
              className="ml-auto flex items-center gap-1.5 rounded-md border border-border bg-secondary px-2.5 py-1 text-xs font-medium transition hover:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <RefreshCw className="size-3.5" aria-hidden="true" />
              Retry
            </button>
          </div>
        )}

        {loading && !data ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-border bg-card py-24">
            <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">Loading console…</p>
          </div>
        ) : data && !data.mandate ? (
          <div className="rounded-lg border border-border bg-card px-6 py-16 text-center">
            <p className="text-sm font-medium">No mandates yet</p>
            <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground text-pretty">
              This principal has not signed a mandate. Run{' '}
              <code className="font-mono text-foreground">npm run demo</code> from the repo root to
              seed a full run, then reload.
            </p>
          </div>
        ) : data?.mandate ? (
          <div className="grid gap-4">
            <div className="grid gap-4 lg:grid-cols-[minmax(280px,340px)_1fr]">
              <MandatePanel mandate={data.mandate} />

              {data.drift ? (
                <DriftDecision drift={data.drift} currency={currency} />
              ) : (
                <section className="flex flex-col items-center justify-center rounded-lg border border-border bg-card px-6 py-12 text-center">
                  <p className="text-sm font-medium">No drift check yet</p>
                  <p className="mt-2 max-w-sm text-sm text-muted-foreground text-pretty">
                    The agent has not submitted a quote against this mandate, so there is nothing
                    to compare.
                  </p>
                </section>
              )}
            </div>

            <AuditLog
              events={data.audit.events}
              blockedCount={data.audit.blockedCount}
              chain={data.chain}
            />

            <SettlementPanel
              settlement={data.settlement}
              intent={data.intent}
              currency={currency}
            />
          </div>
        ) : null}
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-7xl flex-col items-start gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p className="font-mono text-xs text-muted-foreground">
            razortrust · drift engine {data?.drift?.rulesVersion ?? 'v1'} · razorpay manual-capture
          </p>
          <p className="font-mono text-xs text-muted-foreground">
            {data?.chain?.headHash
              ? `chain head ${data.chain.headHash.slice(0, 8)}…${data.chain.headHash.slice(-8)}`
              : 'chain head —'}
          </p>
        </div>
      </footer>
    </div>
  );
}
