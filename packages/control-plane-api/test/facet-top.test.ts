import { describe, expect, it } from 'vitest';
import { facetsFrom } from '../src/aggregate-reads.js';
import { REQUEST_FACET_TOP, facetTop } from '../src/observability.js';
import type { RequestCubeRow } from '../src/aggregate-source.js';

/** #2762: Operation lists its top 7, the facets the design never drew keep ten. */
const T0 = Date.parse('2026-09-27T10:00:00Z');
const rows = (n: number, over: (i: number) => Partial<RequestCubeRow>): RequestCubeRow[] =>
  Array.from({ length: n }, (_, i) => ({
    bucket: T0,
    tenantId: 'tenant-a',
    scopeId: 'app-a',
    level: 'info',
    operation: null,
    problemCode: null,
    principalKind: 'principal',
    surface: 'app',
    status: 200,
    // Strictly falling, so the top N is the first N.
    count: 100 - i,
    ...over(i),
  }));

describe('facet top N', () => {
  it('cuts each facet at its own limit', () => {
    const cube = {
      estimated: false,
      rows: rows(12, (i) => ({ operation: `acme/op${i}`, path: `GET /r${i}`, entity: `e${i}`, state: `e${i}:open` })),
    };
    const { facets } = facetsFrom(cube, { tenantId: 'tenant-a', from: T0, to: T0 + 1000 } as never);
    expect(facets.operation.map((v) => v.value)).toEqual(Array.from({ length: 7 }, (_, i) => `acme/op${i}`));
    for (const key of ['path', 'entity', 'state'] as const) expect(facets[key]).toHaveLength(10);
  });

  it('keeps the default at ten for every facet but Operation', () => {
    expect(facetTop('operation')).toBe(7);
    expect(facetTop('path')).toBe(REQUEST_FACET_TOP);
    expect(REQUEST_FACET_TOP).toBe(10);
  });
});
