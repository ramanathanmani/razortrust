/**
 * Mandate verification — run before authorization AND again before capture.
 *
 * Re-running at capture is the point. Between the hold and the capture a human
 * may have revoked the mandate, the window may have closed, or a stored row may
 * have been edited. Verifying only once, up front, would make all three
 * invisible.
 *
 * Pure and deterministic: `now` is an argument, never a clock read.
 */
import { hashEquals, verifyCanonical } from '../crypto.js';
import { hashMandateTerms } from './hash.js';
import { signingEnvelope } from './sign.js';
import {
  mandateTermsSchema,
  type MandateState,
  type MandateTerms,
  type SignedMandate,
} from './types.js';

export const MANDATE_FAILURE_CODES = [
  'MALFORMED_TERMS',
  'HASH_MISMATCH',
  'BAD_SIGNATURE',
  'NOT_ACTIVE',
  'REVOKED',
  'NOT_YET_VALID',
  'EXPIRED',
  'USES_EXHAUSTED',
  'CUMULATIVE_CEILING_REACHED',
  'AGENT_MISMATCH',
  'TENANT_MISMATCH',
] as const;
export type MandateFailureCode = (typeof MANDATE_FAILURE_CODES)[number];

export interface MandateFailure {
  readonly code: MandateFailureCode;
  readonly message: string;
  readonly detail?: Record<string, string>;
}

export type MandateVerification =
  | { readonly ok: true; readonly terms: MandateTerms }
  | { readonly ok: false; readonly failures: readonly MandateFailure[] };

export interface VerifyMandateArgs {
  readonly mandate: SignedMandate;
  readonly state: MandateState;
  /** Who is asking. Checked against the terms so a mandate cannot be borrowed. */
  readonly presentedBy: { readonly tenantId: string; readonly agentId: string };
  readonly now: Date;
}

export function verifyMandate(args: VerifyMandateArgs): MandateVerification {
  const { mandate, state, presentedBy, now } = args;
  const failures: MandateFailure[] = [];

  // 1. The stored terms must still parse. A row edited by hand fails here.
  const parsed = mandateTermsSchema.safeParse(mandate.terms);
  if (!parsed.success) {
    return {
      ok: false,
      failures: [
        {
          code: 'MALFORMED_TERMS',
          message: 'Stored mandate terms no longer satisfy the mandate schema',
          detail: { issues: parsed.error.issues.map((i) => i.path.join('.')).join(', ') },
        },
      ],
    };
  }
  const terms = parsed.data;

  // 2. The stored hash must be the hash of the stored terms. This is what
  //    catches a terms field being edited without re-signing.
  const recomputed = hashMandateTerms(terms);
  if (!hashEquals(recomputed, mandate.termsHash)) {
    return {
      ok: false,
      failures: [
        {
          code: 'HASH_MISMATCH',
          message: 'Mandate terms do not hash to the stored termsHash — terms were altered',
          detail: { expected: mandate.termsHash, actual: recomputed },
        },
      ],
    };
  }

  // 3. The human's signature must cover that hash.
  const signatureValid = verifyCanonical(
    signingEnvelope(mandate.termsHash),
    mandate.signature,
    mandate.signedByPublicKeyPem,
  );
  if (!signatureValid) {
    return {
      ok: false,
      failures: [
        {
          code: 'BAD_SIGNATURE',
          message: 'Mandate signature does not verify against the signing key',
        },
      ],
    };
  }

  // 4. Lifecycle. Past this point the document is authentic; the question is
  //    whether it is still in force.
  if (state.status === 'revoked') {
    failures.push({
      code: 'REVOKED',
      message: 'Mandate was revoked by the principal',
      ...(state.revokedAt ? { detail: { revokedAt: state.revokedAt } } : {}),
    });
  } else if (state.status !== 'active') {
    failures.push({
      code: 'NOT_ACTIVE',
      message: `Mandate status is "${state.status}", not "active"`,
    });
  }

  const nowMs = now.getTime();
  if (nowMs < Date.parse(terms.notBefore)) {
    failures.push({
      code: 'NOT_YET_VALID',
      message: 'Mandate is not valid yet',
      detail: { notBefore: terms.notBefore, now: now.toISOString() },
    });
  }
  if (nowMs > Date.parse(terms.notAfter)) {
    failures.push({
      code: 'EXPIRED',
      message: 'Mandate has expired',
      detail: { notAfter: terms.notAfter, now: now.toISOString() },
    });
  }

  // 5. Consumption limits.
  if (state.usesCount >= terms.maxUses) {
    failures.push({
      code: 'USES_EXHAUSTED',
      message: `Mandate has been used ${state.usesCount} of ${terms.maxUses} permitted times`,
    });
  }
  if (state.cumulativeAuthorizedPaise >= terms.maxCumulativeAmountPaise) {
    failures.push({
      code: 'CUMULATIVE_CEILING_REACHED',
      message: 'Cumulative spend ceiling for this mandate has been reached',
      detail: {
        spent: state.cumulativeAuthorizedPaise.toString(),
        ceiling: terms.maxCumulativeAmountPaise.toString(),
      },
    });
  }

  // 6. Binding. The mandate names one agent under one tenant.
  if (presentedBy.agentId !== terms.agentId) {
    failures.push({
      code: 'AGENT_MISMATCH',
      message: 'Mandate was issued to a different agent',
      detail: { expected: terms.agentId, presented: presentedBy.agentId },
    });
  }
  if (presentedBy.tenantId !== terms.tenantId) {
    failures.push({
      code: 'TENANT_MISMATCH',
      message: 'Mandate belongs to a different tenant',
      detail: { expected: terms.tenantId, presented: presentedBy.tenantId },
    });
  }

  return failures.length === 0 ? { ok: true, terms } : { ok: false, failures };
}
