import { describe, expect, it } from 'vitest';
import { fromMinorUnits, toMinorUnits } from '../src/index.js';

/**
 * Money between decimal strings and Stripe's minor units: exact both ways, never rounded, and
 * refused for the currencies Stripe amounts differently from their ISO exponent.
 */
describe('stripe money', () => {
  it.each([
    ['124.50', 'SEK', 12450],
    ['12.500', 'SEK', 1250],
    ['50', 'EUR', 5000],
    ['0.05', 'EUR', 5],
    ['500', 'JPY', 500],
    ['500.00', 'JPY', 500],
  ])('%s %s is %i minor units, and back', (amount, currency, minor) => {
    expect(toMinorUnits(amount, currency)).toBe(minor);
    expect(toMinorUnits(fromMinorUnits(minor, currency), currency)).toBe(minor);
  });

  it('writes the currency’s decimals back out', () => {
    expect([fromMinorUnits(12450, 'SEK'), fromMinorUnits(5, 'EUR'), fromMinorUnits(0, 'EUR'), fromMinorUnits(500, 'JPY')]).toEqual(['124.50', '0.05', '0.00', '500']);
  });

  it.each([
    ['12.505', 'SEK', /never rounded/],
    ['500.5', 'JPY', /never rounded/],
    ['-1.00', 'SEK', /non-negative/],
    ['1e3', 'SEK', /non-negative decimal/],
    ['100', 'ISK', /does not charge in it/],
    ['1.000', 'KWD', /does not charge in it/],
    ['1000000.00', 'SEK', /more than Stripe takes/],
  ])('refuses %s %s', (amount, currency, why) => {
    expect(() => toMinorUnits(amount, currency)).toThrow(why);
  });
});
