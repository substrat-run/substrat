/**
 * Meter 3's fold (#1054): one definition of the number, exact money, unpriced kept apart.
 */
import { describe, expect, it } from 'vitest';
import { MARKUP_SEED, instant, scopeId, tenantId, type MarkupRow, type ModelUsageEntry } from '@substrat-run/contracts';
import { foldModelUsage } from '../src/model-usage.js';

const t1 = tenantId.parse('01ARZ3NDEKTSV4RRFFQ69G5FAV');
const t2 = tenantId.parse('01BX5ZZKBKACTAV9WEVGEMMVRZ');
const scope = scopeId.parse('01ARZ3NDEKTSV4RRFFQ69G5FAV');

let n = 0;
const entry = (over: Partial<ModelUsageEntry> & { tenant?: typeof t1; model?: string; listUsd: string | null }): ModelUsageEntry => ({
  id: `0${String(++n).padStart(25, '0')}`,
  requestId: `req-${n}`,
  attribution: { tenant: over.tenant ?? t1, scope, vertical: '@substrat-run/demo-ticket0', version: '0.1.0', operation: 'ticket0/answer' },
  model: over.model ?? 'anthropic:claude-opus-5',
  provider: (over.model ?? 'anthropic:claude-opus-5').split(':')[0]!,
  modelId: (over.model ?? 'anthropic:claude-opus-5').split(':')[1]!,
  reported: true,
  inputTokens: 1000,
  outputTokens: 100,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  at: instant.parse('2026-08-29T10:00:00.000Z'),
  elapsedMs: 10,
  ...over,
});

const window = {
  readAt: '2026-08-29T12:00:00.000Z',
  since: '2026-08-01T00:00:00.000Z',
  until: '2026-09-01T00:00:00.000Z',
  marginPercent: 20,
};

describe('foldModelUsage', () => {
  it('with a markup schedule, prices each line at its tenant\'s model-calls row in force on its own day', () => {
    const override: MarkupRow = {
      id: '01KAKX0000000000000000T001', tenantId: t1, dimension: 'model-calls', kind: null,
      effectiveFrom: '2026-08-15', percent: 100, reason: 'test', setAt: '2026-08-01T00:00:00.000Z', setBy: 'staff',
    };
    const lines = [
      entry({ listUsd: '0.1', at: instant.parse('2026-08-14T23:59:59.000Z') }),
      entry({ listUsd: '0.1', at: instant.parse('2026-08-15T00:00:00.000Z') }),
      entry({ tenant: t2, listUsd: '0.1', attribution: { tenant: t2, scope, vertical: 'v', version: '1', operation: 'o' } }),
    ];
    const s = foldModelUsage(lines, { ...window, markup: [...MARKUP_SEED, override] });
    expect(s.rows.map((r) => r.billedUsd)).toEqual(['0.33', '0.13']);
    expect(s.totals.billedUsd).toBe('0.46');
  });

  it('prices a zero-rated scope\'s lines at zero within their row, keeping the list price and what they would cost', () => {
    const reviews = scopeId.parse('01JZ0000000000000000RVW001');
    const review = { tenant: t1, scope: reviews, vertical: '@substrat-run/demo-ticket0', version: '0.1.0', operation: 'review/read' };
    const lines = [entry({ listUsd: '0.1' }), entry({ listUsd: '0.05', attribution: review }), entry({ listUsd: null, attribution: review })];
    const s = foldModelUsage(lines, { ...window, zeroRatedScopes: [reviews] });
    expect(s.rows).toMatchObject([{ calls: 3, unpriced: 1, listUsd: '0.15', billedUsd: '0.12', zeroRatedCalls: 2, zeroRatedUsd: '0.06' }]);
    expect(s.totals).toMatchObject({ listUsd: '0.15', billedUsd: '0.12', zeroRatedCalls: 2, zeroRatedUsd: '0.06' });
    expect(foldModelUsage(lines, window).totals).toMatchObject({ billedUsd: '0.18', zeroRatedCalls: 0, zeroRatedUsd: '0' });
  });

  it('groups per (tenant, vertical, model), sums money exactly, and applies the margin at read time', () => {
    const s = foldModelUsage(
      [
        entry({ listUsd: '0.1' }),
        entry({ listUsd: '0.2' }),
        entry({ listUsd: '0.3', tenant: t2 }),
        entry({ listUsd: '0.000005', model: 'scaleway:llama-3.3-70b-instruct' }),
      ],
      window,
    );
    expect(s.rows.map((r) => [r.tenantId, r.model, r.calls, r.listUsd, r.billedUsd])).toEqual([
      [t1, 'anthropic:claude-opus-5', 2, '0.3', '0.36'],
      [t1, 'scaleway:llama-3.3-70b-instruct', 1, '0.000005', '0.000006'],
      [t2, 'anthropic:claude-opus-5', 1, '0.3', '0.36'],
    ]);
    // 0.1 + 0.2 is 0.3, not 0.30000000000000004 — decimal strings end to end.
    expect(s.totals.listUsd).toBe('0.600005');
    expect(s.totals.billedUsd).toBe('0.720006');
    expect(s.totals.calls).toBe(4);
    expect(s.totals.inputTokens).toBe(4000);
    expect(s.marginPercent).toBe(20);
  });

  it('counts an unpriced call beside the money, never inside it', () => {
    const s = foldModelUsage([entry({ listUsd: '1' }), entry({ listUsd: null })], window);
    expect(s.rows[0]).toMatchObject({ calls: 2, unpriced: 1, listUsd: '1', billedUsd: '1.2' });
    expect(s.totals).toMatchObject({ calls: 2, unpriced: 1, listUsd: '1', billedUsd: '1.2' });
  });

  it('a zero margin bills list, and an empty window is all zeros', () => {
    expect(foldModelUsage([entry({ listUsd: '2.5' })], { ...window, marginPercent: 0 }).totals.billedUsd).toBe('2.5');
    expect(foldModelUsage([], window).totals).toEqual({
      calls: 0,
      unpriced: 0,
      inputTokens: 0,
      outputTokens: 0,
      listUsd: '0',
      billedUsd: '0',
      zeroRatedCalls: 0,
      zeroRatedUsd: '0',
    });
  });
});
