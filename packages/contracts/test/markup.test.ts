/**
 * The markup schedule's resolution and pricing (#3316, Pricing): most specific row wins, a past
 * day keeps the markup in force then, and price is cost × (1 + markup) in decimal strings.
 */
import { describe, expect, it } from 'vitest';
import {
  MARKUP_SEED,
  markupPercentFor,
  markupRowInput,
  priceCostRows,
  tenantPricedRows,
  type MarkupRow,
} from '../src/markup.js';

const TENANT_A = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const TENANT_B = '01BX5ZZKBKACTAV9WEVGEMMVRZ';

const row = (fields: Partial<MarkupRow> & Pick<MarkupRow, 'id' | 'effectiveFrom' | 'percent'>): MarkupRow => ({
  tenantId: null,
  dimension: null,
  kind: null,
  reason: 'test',
  setAt: '2026-11-21T10:00:00.000Z',
  setBy: 'staff',
  ...fields,
});

describe('markupPercentFor', () => {
  it('prices the seed as the owner decided: 100% default, previews at cost, model calls 30% even in a preview', () => {
    const q = (dimension: 'rows-written' | 'model-calls', kind: 'live' | 'preview') =>
      markupPercentFor(MARKUP_SEED, { tenantId: TENANT_A, dimension, kind, day: '2026-11-21' });
    expect([q('rows-written', 'live'), q('rows-written', 'preview'), q('model-calls', 'live'), q('model-calls', 'preview')])
      .toEqual([100, 0, 30, 30]);
  });

  it('lets a tenant row beat every platform row, from its day on, and leaves other tenants alone', () => {
    const schedule = [...MARKUP_SEED, row({ id: 'T1', tenantId: TENANT_A as MarkupRow['tenantId'], effectiveFrom: '2026-12-01', percent: 50 })];
    const at = (tenantId: string, day: string) =>
      markupPercentFor(schedule, { tenantId, dimension: 'model-calls', kind: 'preview', day });
    expect([at(TENANT_A, '2026-11-30'), at(TENANT_A, '2026-12-01'), at(TENANT_B, '2026-12-01')]).toEqual([30, 50, 30]);
  });

  it('keeps a past day at the markup in force then, and lets a same-day correction supersede by setAt', () => {
    const schedule = [
      row({ id: 'D1', effectiveFrom: '2026-01-01', percent: 100 }),
      row({ id: 'D2', effectiveFrom: '2027-01-01', percent: 80 }),
      row({ id: 'D3', effectiveFrom: '2027-01-01', percent: 70, setAt: '2026-11-22T00:00:00.000Z' }),
    ];
    const at = (day: string) => markupPercentFor(schedule, { tenantId: null, dimension: 'cpu', kind: 'live', day });
    expect([at('2026-12-31'), at('2027-01-01')]).toEqual([100, 70]);
  });

  it('ends an override with a null row, falling through to the next level, and answers null with no row at all', () => {
    const schedule = [
      ...MARKUP_SEED,
      row({ id: 'T1', tenantId: TENANT_A as MarkupRow['tenantId'], effectiveFrom: '2026-12-01', percent: 50 }),
      row({ id: 'T2', tenantId: TENANT_A as MarkupRow['tenantId'], effectiveFrom: '2027-01-01', percent: null }),
    ];
    const at = (day: string) => markupPercentFor(schedule, { tenantId: TENANT_A, dimension: 'cpu', kind: 'live', day });
    expect([at('2026-12-15'), at('2027-01-01')]).toEqual([50, 100]);
    expect(markupPercentFor([], { tenantId: null, dimension: 'cpu', kind: 'live', day: '2026-12-01' })).toBeNull();
  });
});

describe('markupRowInput', () => {
  it('refuses a platform default without a percent, a fractional percent and an impossible day', () => {
    for (const bad of [
      { effectiveFrom: '2026-12-01', percent: null, reason: 'x' },
      { effectiveFrom: '2026-12-01', percent: 12.5, reason: 'x' },
      { effectiveFrom: '2026-02-30', percent: 10, reason: 'x' },
    ]) {
      expect(markupRowInput.safeParse(bad).success).toBe(false);
    }
  });
});

describe('pricing cost rows', () => {
  const costs = [
    { day: '2026-11-20', tenantId: TENANT_A, dimension: 'rows-written' as const, kind: 'live' as const, costUsd: '1.234567' },
    { day: '2026-11-20', tenantId: TENANT_A, dimension: 'rows-written' as const, kind: 'preview' as const, costUsd: '2.5' },
  ];

  it('shows staff cost, markup and price side by side, and the tenant the price alone', () => {
    expect(priceCostRows(costs, MARKUP_SEED).map((r) => [r.costUsd, r.markupPercent, r.priceUsd])).toEqual([
      ['1.234567', 100, '2.469134'],
      ['2.5', 0, '2.5'],
    ]);
    expect(tenantPricedRows(costs, MARKUP_SEED)[0]).toEqual({ day: '2026-11-20', dimension: 'rows-written', kind: 'live', priceUsd: '2.469134' });
    expect(priceCostRows(costs, [])[0]).toMatchObject({ markupPercent: null, priceUsd: null });
  });
});
