import { describe, expect, it } from 'vitest';
import { listCostOf, listRatesOn, mulDivDecimal, platformQuantityOf } from '../src/index.js';

describe('mulDivDecimal (#3316)', () => {
  it('rounds once, at the end, half-up', () => {
    // 485 rows read at $0.001 per million: dividing first would give 0.
    expect(mulDivDecimal('485000', '0.001', 1_000_000)).toBe('0.000485');
    expect(mulDivDecimal('1', '0.5', 1_000_000)).toBe('0.000001');
    expect(mulDivDecimal('1', '0.49', 1_000_000)).toBe('0');
    expect(() => mulDivDecimal('1', '1', 0)).toThrow(RangeError);
  });
});

describe('list cost (#3316)', () => {
  it('prices each dimension at its list rate', () => {
    expect(listCostOf('rows-written', '2500000', '2026-11-10')).toBe('2.5');
    expect(listCostOf('rows-read', '1000000', '2026-11-10')).toBe('0.001');
    expect(listCostOf('do-requests', '2000000', '2026-11-10')).toBe('0.3');
    expect(listCostOf('duration', '400000', '2026-11-10')).toBe('5');
    expect(listCostOf('requests', '1000000', '2026-11-10')).toBe('0.3');
    // CPU is stored in µs and billed per million ms.
    expect(listCostOf('cpu', platformQuantityOf('worker_cpu_us', '3000000000'), '2026-11-10')).toBe('0.06');
  });

  it("charges a day's storage at its month's share of the GB-month", () => {
    // 3 GB for one day of a 30-day month is 0.1 GB-month: $0.02.
    expect(listCostOf('storage', '3000000000', '2026-11-10')).toBe('0.02');
    // 31 GB for one day of a 31-day month is 1 GB-month.
    expect(listCostOf('storage', '31000000000', '2026-12-10')).toBe('0.2');
  });

  it('knows no rate before the first entry', () => {
    expect(listRatesOn('1999-12-31')).toEqual([]);
    expect(listCostOf('rows-written', '1', '1999-12-31')).toBeNull();
  });
});
