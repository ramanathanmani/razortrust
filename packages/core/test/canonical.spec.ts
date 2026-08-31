import { describe, expect, it } from 'vitest';

import { canonicalize, CanonicalizationError } from '../src/canonical.js';
import { sha256Canonical } from '../src/crypto.js';

describe('canonicalize', () => {
  it('sorts object keys so key order cannot change the hash', () => {
    const a = { zebra: 1, apple: 2, mango: { z: 1, a: 2 } };
    const b = { mango: { a: 2, z: 1 }, apple: 2, zebra: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(canonicalize(a)).toBe('{"apple":2,"mango":{"a":2,"z":1},"zebra":1}');
  });

  it('treats an absent key and an undefined key as the same document', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
  });

  it('emits bigint as a string so paise never lose precision', () => {
    expect(canonicalize({ amount: 9007199254740993n })).toBe('{"amount":"9007199254740993"}');
  });

  it('preserves array order, because order is meaning', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
  });

  it('rejects floats rather than letting platform formatting into the hash', () => {
    expect(() => canonicalize({ price: 499.99 })).toThrow(CanonicalizationError);
  });

  it('rejects NaN and Infinity', () => {
    expect(() => canonicalize({ x: NaN })).toThrow(CanonicalizationError);
    expect(() => canonicalize({ x: Infinity })).toThrow(CanonicalizationError);
  });

  it('rejects top-level undefined', () => {
    expect(() => canonicalize(undefined)).toThrow(CanonicalizationError);
  });

  it('rejects circular references instead of hanging', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    expect(() => canonicalize(obj)).toThrow(/Circular/);
  });

  it('normalises -0 to 0', () => {
    expect(canonicalize({ x: -0 })).toBe('{"x":0}');
  });

  it('renders Dates as UTC ISO strings', () => {
    expect(canonicalize({ at: new Date('2026-08-28T12:00:00.000Z') })).toBe(
      '{"at":"2026-08-28T12:00:00.000Z"}',
    );
  });

  it('escapes strings the same way JSON does', () => {
    expect(canonicalize({ s: 'a"b\\c\nd' })).toBe(JSON.stringify({ s: 'a"b\\c\nd' }));
  });

  it('produces a stable hash across differently-ordered equivalents', () => {
    const one = { b: 2n, a: [{ y: 1, x: 2 }] };
    const two = { a: [{ x: 2, y: 1 }], b: 2n };
    expect(sha256Canonical(one)).toBe(sha256Canonical(two));
  });
});
