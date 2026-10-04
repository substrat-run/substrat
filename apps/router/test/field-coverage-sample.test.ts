import { describe, expect, it } from 'vitest';
import { fieldCoverageSampled, fieldCoverageSampleRate } from '../src/field-coverage-sample.js';

describe('field-coverage sampling (#1923)', () => {
  it('reads a decimal rate in (0, 1]', () => {
    expect(fieldCoverageSampleRate('0.01')).toBe(0.01);
    expect(fieldCoverageSampleRate(' 0.5 ')).toBe(0.5);
    expect(fieldCoverageSampleRate('1')).toBe(1);
    expect(fieldCoverageSampleRate(0.25)).toBe(0.25);
  });

  it('reads every doubtful value as off, above one included', () => {
    for (const v of [undefined, null, '', ' ', 'on', 'NaN', NaN, 'Infinity', Infinity, '-0.1', -1, '0', 0, '1.0001', '50', 2, {}, true]) {
      expect(fieldCoverageSampleRate(v), String(v)).toBe(0);
    }
  });

  it('samples by the rate: never at 0, always at 1, and below the draw in between', () => {
    const never = () => {
      throw new Error('drew a number at a rate that cannot sample');
    };
    expect(fieldCoverageSampled(0, never)).toBe(false);
    expect(fieldCoverageSampled(NaN, never)).toBe(false);
    expect(fieldCoverageSampled(1.5, never)).toBe(false);
    expect(fieldCoverageSampled(1, never)).toBe(true);
    expect(fieldCoverageSampled(0.25, () => 0.2499)).toBe(true);
    expect(fieldCoverageSampled(0.25, () => 0.25)).toBe(false);
    expect(fieldCoverageSampled(0.25, () => 0.9)).toBe(false);
  });

  it('samples about the rate over many draws', () => {
    let seed = 7;
    const lcg = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    let hits = 0;
    for (let i = 0; i < 20_000; i++) if (fieldCoverageSampled(0.1, lcg)) hits++;
    expect(hits / 20_000).toBeGreaterThan(0.09);
    expect(hits / 20_000).toBeLessThan(0.11);
  });
});
