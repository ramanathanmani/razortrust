import { describe, expect, it } from 'vitest';

import {
  formatMajorUnit,
  fromMajorUnitString,
  MoneyError,
  multiplyByQuantity,
  percentFloor,
  subtract,
  sum,
  toPaise,
} from '../src/money.js';

describe('toPaise', () => {
  it('accepts integer strings, numbers and bigints', () => {
    expect(toPaise('49900')).toBe(49900n);
    expect(toPaise(49900)).toBe(49900n);
    expect(toPaise(49900n)).toBe(49900n);
  });

  it('rejects fractional paise rather than rounding a ceiling away', () => {
    expect(() => toPaise(499.5)).toThrow(MoneyError);
    expect(() => toPaise('499.5')).toThrow(MoneyError);
  });

  it('rejects negative amounts', () => {
    expect(() => toPaise('-1')).toThrow(MoneyError);
  });

  it('rejects values beyond the safe integer range as numbers', () => {
    expect(() => toPaise(Number.MAX_SAFE_INTEGER + 2)).toThrow(MoneyError);
  });
});

describe('fromMajorUnitString', () => {
  it('converts rupee strings exactly', () => {
    expect(fromMajorUnitString('499.00', 'INR')).toBe(49900n);
    expect(fromMajorUnitString('499.9', 'INR')).toBe(49990n);
    expect(fromMajorUnitString('499', 'INR')).toBe(49900n);
    expect(fromMajorUnitString('0.01', 'INR')).toBe(1n);
  });

  it('refuses more precision than the currency has', () => {
    expect(() => fromMajorUnitString('499.999', 'INR')).toThrow(/precision/);
  });

  it('round-trips through formatMajorUnit', () => {
    for (const s of ['0.00', '1.05', '2500.00', '99999.99']) {
      expect(formatMajorUnit(fromMajorUnitString(s, 'INR'), 'INR')).toBe(
        s === '499' ? '499.00' : s,
      );
    }
  });
});

describe('arithmetic', () => {
  it('sums line totals without float drift', () => {
    // 0.1 + 0.2 in rupees, three times over — exact in paise.
    const lines = [10n, 20n, 10n, 20n, 10n, 20n];
    expect(sum(lines)).toBe(90n);
  });

  it('refuses to go negative on subtraction', () => {
    expect(() => subtract(100n, 101n)).toThrow(MoneyError);
  });

  it('multiplies only by whole quantities', () => {
    expect(multiplyByQuantity(49900n, 3)).toBe(149700n);
    expect(() => multiplyByQuantity(49900n, 1.5)).toThrow(MoneyError);
  });

  it('rounds partial refunds down, never up', () => {
    // 33% of ₹10.00 is 330 paise exactly; 33% of ₹10.01 is 330.33 -> 330.
    expect(percentFloor(1000n, 33)).toBe(330n);
    expect(percentFloor(1001n, 33)).toBe(330n);
    expect(percentFloor(1000n, 100)).toBe(1000n);
    expect(percentFloor(1000n, 0)).toBe(0n);
  });

  it('rejects nonsensical percentages', () => {
    expect(() => percentFloor(1000n, 101)).toThrow(MoneyError);
    expect(() => percentFloor(1000n, 12.5)).toThrow(MoneyError);
  });
});
