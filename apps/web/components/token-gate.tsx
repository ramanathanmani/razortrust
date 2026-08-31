'use client';

import { KeyRound, ShieldCheck } from 'lucide-react';
import { useState } from 'react';

/**
 * The sign-in gate.
 *
 * The console shows one principal's mandates, so it needs that principal's
 * bearer token. There is no session cookie and no identity provider here by
 * design — `rzt_principal_` tokens are the only human credential the API
 * accepts, and inventing a second auth path for a dashboard would mean two
 * places to get wrong.
 *
 * The token is held in sessionStorage and never leaves this origin: requests
 * go through the same-origin `/api` rewrite.
 */
export function TokenGate({ onSubmit, error }: { onSubmit: (token: string) => void; error?: string }) {
  const [value, setValue] = useState('');

  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-10">
      <form
        className="w-full max-w-md rounded-lg border border-border bg-card p-6"
        onSubmit={(e) => {
          e.preventDefault();
          const t = value.trim();
          if (t) onSubmit(t);
        }}
      >
        <div className="flex items-center gap-3 border-b border-border pb-4">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-secondary">
            <ShieldCheck className="size-4 text-success" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-tight">RazorTrust</h1>
            <p className="text-xs text-muted-foreground">
              An AI agent can only pay for what a human actually approved
            </p>
          </div>
        </div>

        <label htmlFor="token" className="mt-5 block text-xs uppercase tracking-wider text-muted-foreground">
          Principal token
        </label>
        <div className="mt-2 flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 focus-within:ring-2 focus-within:ring-ring">
          <KeyRound className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            id="token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="rzt_principal_…"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="w-full bg-transparent font-mono text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>

        {error && (
          <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={!value.trim()}
          className="mt-4 w-full rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-40"
        >
          Open console
        </button>

        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
          Run <code className="font-mono text-foreground">npm run demo</code> to seed data — it
          prints a principal token at the end. The token stays in this tab only.
        </p>
      </form>
    </div>
  );
}
