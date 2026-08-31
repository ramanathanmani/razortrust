/**
 * Deterministic JSON serialisation (JCS / RFC 8785 in spirit).
 *
 * Two things depend on byte-for-byte reproducibility:
 *   1. A mandate's hash, which the human signs and which is re-verified at
 *      capture time. If serialisation wobbles, the signature stops matching
 *      and every payment fails — or worse, a rewritten mandate hashes the same.
 *   2. The audit hash chain, which must be recomputable years later.
 *
 * So: object keys sorted by UTF-16 code unit, no insignificant whitespace,
 * bigint rendered as a decimal string, and anything ambiguous rejected loudly
 * rather than coerced.
 */

export class CanonicalizationError extends Error {
  override readonly name = 'CanonicalizationError';
}

export type CanonicalValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

export function canonicalize(value: unknown): string {
  return write(value, new Set(), '$');
}

function write(value: unknown, seen: Set<object>, path: string): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';

    case 'string':
      return JSON.stringify(value);

    case 'bigint':
      // Money is bigint everywhere. Emitted as a JSON string so the value
      // survives any parser without precision loss.
      return JSON.stringify(value.toString());

    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError(`Non-finite number at ${path}: ${value}`);
      }
      if (!Number.isInteger(value)) {
        // Floats never carry money here, and admitting them would make hashes
        // depend on the platform's float formatting.
        throw new CanonicalizationError(
          `Non-integer number at ${path}: ${value}. Use a string or bigint.`,
        );
      }
      if (!Number.isSafeInteger(value)) {
        throw new CanonicalizationError(`Number exceeds safe integer range at ${path}: ${value}`);
      }
      // Normalise -0 to 0.
      return Object.is(value, -0) ? '0' : String(value);

    case 'undefined':
      throw new CanonicalizationError(
        `undefined at ${path}. Omit the key or use null — the distinction must be explicit.`,
      );

    case 'object':
      break;

    default:
      throw new CanonicalizationError(`Cannot canonicalize ${typeof value} at ${path}`);
  }

  const obj = value as object;
  if (seen.has(obj)) throw new CanonicalizationError(`Circular reference at ${path}`);
  seen.add(obj);

  try {
    if (Array.isArray(obj)) {
      const items = obj.map((item, i) => write(item, seen, `${path}[${i}]`));
      return `[${items.join(',')}]`;
    }

    if (obj instanceof Date) {
      // Always UTC, always millisecond precision.
      return JSON.stringify(obj.toISOString());
    }

    if (Object.getPrototypeOf(obj) !== Object.prototype && Object.getPrototypeOf(obj) !== null) {
      throw new CanonicalizationError(
        `Only plain objects, arrays and Dates can be canonicalized. Got ${obj.constructor?.name} at ${path}.`,
      );
    }

    const entries = Object.entries(obj as Record<string, unknown>)
      // An absent key and an explicitly-undefined key must hash identically.
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    const parts = entries.map(
      ([k, v]) => `${JSON.stringify(k)}:${write(v, seen, `${path}.${k}`)}`,
    );
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(obj);
  }
}

/** UTF-8 bytes of the canonical form — what actually gets hashed and signed. */
export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalize(value), 'utf8');
}
