/**
 * Signing a mandate.
 *
 * The signature covers `{domain, termsHash}` rather than the full terms. That
 * keeps what the human confirms short enough to display and compare by eye,
 * while the hash still binds every field.
 *
 * In production the private key belongs to the human principal and this
 * function runs on their side. It lives in core so the server can verify with
 * exactly the same construction it would have used to sign.
 */
import { signCanonical } from '../crypto.js';
import { hashMandateTerms, MANDATE_HASH_DOMAIN } from './hash.js';
import { mandateTermsSchema, type MandateTerms, type SignedMandate } from './types.js';

/** The exact structure that gets signed. Kept in one place, used by both sides. */
export function signingEnvelope(termsHash: string): { domain: string; termsHash: string } {
  return { domain: MANDATE_HASH_DOMAIN, termsHash };
}

export function signMandate(
  rawTerms: unknown,
  privateKeyPem: string,
  publicKeyPem: string,
  signedAt: string,
): SignedMandate {
  const terms: MandateTerms = mandateTermsSchema.parse(rawTerms);
  const termsHash = hashMandateTerms(terms);

  return {
    terms,
    termsHash,
    signature: signCanonical(signingEnvelope(termsHash), privateKeyPem),
    signedByPublicKeyPem: publicKeyPem,
    signedAt,
  };
}
