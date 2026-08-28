/**
 * The öre ↔ Money seam is exact. Every case here is one a float round-trip gets
 * wrong or nearly wrong: `1.005 * 100` is `100.49999…`, `0.1 + 0.2` is not `0.3`,
 * and a share of a court must come out the same whichever player asks.
 */
import { describe, expect, it } from 'vitest';
import { addDecimal, moneyOf } from '@substrat-run/contracts';
import { moneyFromOre, oreOf, shareOf } from '../src/money.js';

describe('oreOf — a price as integer öre', () => {
  it('reads whole kronor and two decimals exactly', () => {
    expect(oreOf(moneyOf('340', 'SEK'))).toBe(34_000);
    expect(oreOf(moneyOf('17.5', 'SEK'))).toBe(1_750);
    expect(oreOf(moneyOf('17.50', 'SEK'))).toBe(1_750);
    expect(oreOf(moneyOf('0.07', 'SEK'))).toBe(7);
    expect(oreOf(moneyOf('0', 'SEK'))).toBe(0);
  });

  it('rounds half-up at the 2nd decimal, where Number(x) * 100 would not', () => {
    // 1.005 * 100 === 100.49999999999999 → Math.round gives 100; the price is 101 öre.
    expect(oreOf(moneyOf('1.005', 'SEK'))).toBe(101);
    expect(oreOf(moneyOf('2.675', 'SEK'))).toBe(268);
    expect(oreOf(moneyOf('4.35', 'SEK'))).toBe(435); // 4.35 * 100 === 434.99999999999994
    expect(oreOf(moneyOf('1.0049', 'SEK'))).toBe(100);
  });

  it('keeps the sign', () => {
    expect(oreOf(moneyOf('-17.5', 'SEK'))).toBe(-1_750);
    expect(oreOf(moneyOf('-1.005', 'SEK'))).toBe(-101);
  });
});

describe('moneyFromOre — integer öre back to Money', () => {
  it('renders whole kronor without decimals and fractions with two', () => {
    expect(moneyFromOre(34_000, 'SEK').amount).toBe('340');
    expect(moneyFromOre(1_750, 'SEK').amount).toBe('17.50');
    expect(moneyFromOre(7, 'SEK').amount).toBe('0.07');
    expect(moneyFromOre(0, 'SEK').amount).toBe('0');
    expect(moneyFromOre(-1_750, 'SEK').amount).toBe('-17.50');
    expect(moneyFromOre(1_700).currency).toBe('SEK');
    expect(moneyFromOre(1_700, 'NOK').currency).toBe('NOK');
  });

  it('round-trips every öre amount a price list can hold', () => {
    for (const ore of [1, 99, 100, 101, 12_345, 100_000, 99_999_999]) {
      expect(oreOf(moneyFromOre(ore, 'SEK'))).toBe(ore);
    }
  });

  it('refuses a fractional öre rather than rounding one silently', () => {
    expect(() => moneyFromOre(17.5, 'SEK')).toThrow(/integer/);
  });
});

describe('shareOf — one player’s share of a court', () => {
  it('splits in whole currency units, half-up', () => {
    expect(shareOf(moneyOf('340', 'SEK'), 2).amount).toBe('170');
    expect(shareOf(moneyOf('340', 'SEK'), 4).amount).toBe('85');
    expect(shareOf(moneyOf('340', 'SEK'), 3).amount).toBe('113'); // 113.33…
    expect(shareOf(moneyOf('345', 'SEK'), 2).amount).toBe('173'); // 172.5 → 173
    expect(shareOf(moneyOf('350.50', 'SEK'), 4).amount).toBe('88'); // 87.625 → 88
  });

  it('treats a fill target below 1 as the whole court', () => {
    expect(shareOf(moneyOf('340', 'SEK'), 0).amount).toBe('340');
    expect(shareOf(moneyOf('340', 'SEK'), 1).amount).toBe('340');
  });

  it('keeps the currency', () => {
    expect(shareOf(moneyOf('400', 'NOK'), 4).currency).toBe('NOK');
  });
});

describe('revenue — a sum of prices is a decimal sum', () => {
  it('has no float drift', () => {
    // 0.1 + 0.2 as floats is 0.30000000000000004; as prices it is 0.3.
    const total = ['0.1', '0.2', '340', '17.50'].reduce((sum, p) => addDecimal(sum, p), '0');
    expect(total).toBe('357.8');
  });
});
