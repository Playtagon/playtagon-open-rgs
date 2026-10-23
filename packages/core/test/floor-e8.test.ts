import { expect, test } from 'bun:test';
import { settleFloorE8, settleAmount } from '../src/money.js';

test('exact floor deliberately differs from existing half-even without changing it', () => {
  expect(settleFloorE8('150000000', 1)).toBe(1);
  expect(settleAmount(1.5, 1)).toBe(2);
  expect(settleFloorE8('101000000', 100)).toBe(101);
  expect(settleFloorE8('0', 100)).toBe(0);
});
test('does not round an E8 value up at a binary floating point boundary', () => {
  expect(settleFloorE8('199999999', 100_000_000)).toBe(199_999_999);
  expect(() => settleFloorE8('100000001', 9007199254740990)).toThrow();
});
test('rejects malformed E8 and unsafe/fractional money', () => {
  for (const scaled of ['-1', '1.5', '01', '1e8', '9'.repeat(25)]) expect(() => settleFloorE8(scaled, 100)).toThrow();
  for (const bet of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) expect(() => settleFloorE8('100000000', bet)).toThrow();
  expect(() => settleFloorE8('200000000', Number.MAX_SAFE_INTEGER)).toThrow();
});
