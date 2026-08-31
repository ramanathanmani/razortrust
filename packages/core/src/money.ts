/**
 * Money in RazorTrust is always an integer number of paise, carried as bigint.
 *
 * Floats are banned end to end. A drift check that says "the quote is 2 paise
 * over the ceiling" has to be exactly right, and 0.1 + 0.2 is not.
 */

/** An integer amount of the smallest currency unit (paise for INR). */
export type Paise = bigint;

/** Currencies RazorTrust will quote and settle in. Razorpay-first. */
export const SUPPORTED_CURRENCIES = ['INR'] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

/** Minor units per major unit, per currency. INR: 100 paise to the rupee. */
const MINOR_UNITS: Record<Currency, number> = { INR: 100 };

export class MoneyError extends Error {
  override readonly name = 'MoneyError';
}

export function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}

export function assertCurrency(value: unknown): Currency {
  if (!isCurrency(value)) {
    throw new MoneyError(`Unsupported currency: ${String(value)}`);
  }
  return value;
}

/**
 * Parse an amount that arrived as a string or a safe integer.
 *
 * Anything with a decimal point, an exponent, or a fractional value is
 * rejected rather than rounded. A merchant quote of "499.999" is a data
 * problem, and silently rounding it is how ceilings get bypassed.
 */
export function toPaise(value: string | number | bigint): Paise {
  if (typeof value === 'bigint') return assertNonNegative(value);

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new MoneyError(`Amount is not finite: ${value}`);
    if (!Number.isInteger(value)) {
      throw new MoneyError(`Amount must be an integer count of paise, got ${value}`);
    }
    if (!Number.isSafeInteger(value)) {
      throw new MoneyError(`Amount exceeds safe integer range: ${value}`);
    }
    return assertNonNegative(BigInt(value));
  }

  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new MoneyError(`Amount must be an integer string of paise, got "${value}"`);
  }
  return assertNonNegative(BigInt(trimmed));
}

function assertNonNegative(v: Paise): Paise {
  if (v < 0n) throw new MoneyError(`Amount must not be negative, got ${v}`);
  return v;
}

/** Convert a major-unit decimal string ("499.00") into paise. Never a float. */
export function fromMajorUnitString(value: string, currency: Currency): Paise {
  const minor = MINOR_UNITS[currency];
  const scale = String(minor).length - 1;

  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new MoneyError(`Not a valid ${currency} amount: "${value}"`);

  const whole = match[1] ?? '0';
  const frac = match[2] ?? '';
  if (frac.length > scale) {
    throw new MoneyError(
      `"${value}" has more precision than ${currency} supports (${scale} decimal places)`,
    );
  }

  return BigInt(whole) * BigInt(minor) + BigInt(frac.padEnd(scale, '0') || '0');
}

/** Render paise for humans and audit payloads: 49900n -> "499.00". */
export function formatMajorUnit(amount: Paise, currency: Currency): string {
  const minor = BigInt(MINOR_UNITS[currency]);
  const scale = String(MINOR_UNITS[currency]).length - 1;
  const whole = amount / minor;
  const frac = amount % minor;
  return scale === 0 ? whole.toString() : `${whole}.${frac.toString().padStart(scale, '0')}`;
}

export function add(a: Paise, b: Paise): Paise {
  return a + b;
}

export function subtract(a: Paise, b: Paise): Paise {
  if (b > a) throw new MoneyError(`Subtraction would go negative: ${a} - ${b}`);
  return a - b;
}

/** Multiply an amount by a whole quantity. Quantities are never fractional. */
export function multiplyByQuantity(unitAmount: Paise, quantity: number): Paise {
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new MoneyError(`Quantity must be a non-negative integer, got ${quantity}`);
  }
  return unitAmount * BigInt(quantity);
}

export function sum(amounts: readonly Paise[]): Paise {
  return amounts.reduce<Paise>((acc, n) => acc + n, 0n);
}

/**
 * Percentage of an amount, rounded DOWN to the paise.
 *
 * Used by partial-refund rules. Rounding down means an arithmetic edge case
 * costs the customer at most one paise and never over-refunds the merchant's
 * money by accident.
 */
export function percentFloor(amount: Paise, percent: number): Paise {
  if (!Number.isSafeInteger(percent) || percent < 0 || percent > 100) {
    throw new MoneyError(`Percent must be a whole number 0-100, got ${percent}`);
  }
  return (amount * BigInt(percent)) / 100n;
}

export const min = (a: Paise, b: Paise): Paise => (a < b ? a : b);
export const max = (a: Paise, b: Paise): Paise => (a > b ? a : b);
