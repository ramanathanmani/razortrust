/**
 * The hash that binds a mandate to its signature.
 *
 * Deliberately trivial: hashing is `sha256(canonical(terms))` and nothing else.
 * Any extra cleverness here (normalising, defaulting, trimming) would be a
 * place where a stored mandate and a re-derived one could disagree.
 */
import { sha256Canonical } from '../crypto.js';
import { mandateTermsSchema, type MandateTerms } from './types.js';

/** Domain separator, so a mandate hash can never be confused for another kind. */
export const MANDATE_HASH_DOMAIN = 'razortrust.mandate.v1' as const;

export function hashMandateTerms(terms: MandateTerms): string {
  return sha256Canonical({ domain: MANDATE_HASH_DOMAIN, terms });
}

/**
 * Validate raw input and hash it in one step.
 *
 * Used when a mandate arrives from the console or the API: the caller gets
 * back the parsed terms and the exact hash the human is about to sign.
 */
export function prepareMandateForSigning(rawTerms: unknown): {
  terms: MandateTerms;
  termsHash: string;
  canonicalPayload: string;
} {
  const terms = mandateTermsSchema.parse(rawTerms);
  return {
    terms,
    termsHash: hashMandateTerms(terms),
    canonicalPayload: JSON.stringify({ domain: MANDATE_HASH_DOMAIN, termsHash: hashMandateTerms(terms) }),
  };
}
