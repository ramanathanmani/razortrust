/**
 * Structured columns are TEXT holding CANONICAL JSON.
 *
 * SQLite has no Json type in Prisma, but that constraint turned out to be the
 * right default anyway: the canonical form is what gets hashed and signed, so
 * storing anything else would mean the bytes on disk and the bytes in the
 * signature could drift apart.
 */
import { canonicalize } from '@razortrust/core';

export function toCanonicalJson(value: unknown): string {
  return canonicalize(value);
}

export function fromCanonicalJson<T = Record<string, unknown>>(text: string): T {
  return JSON.parse(text) as T;
}

/**
 * Re-serialise stored text through the canonicalizer.
 *
 * Use when comparing a stored blob against a freshly computed one: it proves
 * the stored text really is canonical rather than merely equivalent.
 */
export function recanonicalize(text: string): string {
  return canonicalize(JSON.parse(text));
}

export function isCanonical(text: string): boolean {
  try {
    return recanonicalize(text) === text;
  } catch {
    return false;
  }
}
