/**
 * The aggregate reads, computed ONCE from cubes (#1877) — the request histogram, the
 * facet counts and the log patterns, whatever source produced the cubes.
 *
 * Pure, so the semantics the routes promise are held here and nowhere else, and the
 * contract suite can drive them over any `AggregateSource`:
 *
 * - **the tenant, and the scope when one is named, are applied first** — a cube carries
 *   every tenant of its service, and no other tenant's row may reach an answer;
 * - a facet is counted with every OTHER filter applied and its own left out;
 * - a line with no `level` is `unrecorded`, counted and never dropped;
 * - a pattern's share is of every matching `ctx.log` line, not only the listed ones;
 * - `estimated` is carried through from any sampled part of a cube.
 */
import { grainFor, type AggregateSource, type Cube, type PatternCubeRow, type RequestCubeRow } from './aggregate-source.js';
import {
  LOG_PATTERN_TOP,
  REQUEST_FACET_KEYS,
  REQUEST_FACET_TOP,
  type LogPattern,
  type LogPatternLevel,
  type LogPatterns,
  type RequestFacetKey,
  type RequestFacetValue,
  type RequestFacets,
  type RequestVolume,
  type RequestVolumeBucket,
  type RequestWhere,
  type ObservabilityReader,
  type TenantRequestScope,
} from './observability.js';

/** Who and what a read is about — the tenant is the narrowing, never widened. */
export interface AggregateScope {
  tenantId: string;
  scopeId?: string | undefined;
  where?: RequestWhere | undefined;
}

/** The caller's rows: its tenant, and its scope when it named one. Applied before anything else. */
function own<R extends { tenantId: string; scopeId: string | null }>(rows: readonly R[], scope: AggregateScope): R[] {
  return rows.filter((r) => r.tenantId === scope.tenantId && (!scope.scopeId || r.scopeId === scope.scopeId));
}

/** A request row's value for a facet, as a filter compares it (status as text). */
function facetValue(r: RequestCubeRow, key: RequestFacetKey): string | null {
  const v = r[key];
  return v === null || v === undefined ? null : String(v);
}

/** Does a row pass every facet filter — except `omit`'s, when counting that facet? */
function passes(r: RequestCubeRow, where: RequestWhere | undefined, omit?: RequestFacetKey): boolean {
  for (const key of REQUEST_FACET_KEYS) {
    if (key === omit) continue;
    const values = where?.[key];
    if (!values || values.length === 0) continue;
    const v = facetValue(r, key);
    if (v === null || !values.includes(v)) return false;
  }
  return true;
}

/**
 * The width a histogram's bars are drawn at: the asked-for count over the window, never
 * finer than the cube's grain, and a whole number of grains so no grain is split.
 */
export function barWidth(span: number, buckets: number, grainMs: number): number {
  return Math.max(grainMs, Math.ceil(span / Math.max(1, buckets) / grainMs) * grainMs);
}

const levelOf = (v: string | null): keyof Omit<RequestVolumeBucket, 'start'> =>
  v === 'info' || v === 'warn' || v === 'error' ? v : 'unrecorded';

/** The request histogram: per-level counts per bar, bars with no requests left out. */
export function volumeFrom(
  cube: Cube<RequestCubeRow>,
  scope: AggregateScope & { from: number; to: number; buckets: number; grainMs: number },
): RequestVolume {
  const width = barWidth(scope.to - scope.from, scope.buckets, scope.grainMs);
  const bars = new Map<number, RequestVolumeBucket>();
  for (const r of own(cube.rows, scope)) {
    if (!passes(r, scope.where)) continue;
    const start = scope.from + Math.floor((r.bucket - scope.from) / width) * width;
    const bar = bars.get(start) ?? { start: new Date(start).toISOString(), info: 0, warn: 0, error: 0, unrecorded: 0 };
    bar[levelOf(r.level)] += r.count;
    bars.set(start, bar);
  }
  return {
    bucketMs: width,
    buckets: [...bars.entries()].sort(([a], [b]) => a - b).map(([, b]) => b),
    estimated: cube.estimated,
  };
}

/** Facet counts: each facet with every other filter applied and its own left out. */
export function facetsFrom(
  cube: Cube<RequestCubeRow>,
  scope: AggregateScope & { keys?: readonly RequestFacetKey[] | undefined },
): RequestFacets {
  const rows = own(cube.rows, scope);
  const total = rows.filter((r) => passes(r, scope.where)).reduce((n, r) => n + r.count, 0);
  const facets = Object.fromEntries(REQUEST_FACET_KEYS.map((k) => [k, [] as RequestFacetValue[]])) as Record<
    RequestFacetKey,
    RequestFacetValue[]
  >;
  for (const key of scope.keys ?? REQUEST_FACET_KEYS) {
    const counts = new Map<string, number>();
    for (const r of rows) {
      if (!passes(r, scope.where, key)) continue;
      const v = facetValue(r, key);
      // A line with no value for this key is not a value anybody can filter on; the total
      // above still counts it.
      if (v === null || v === '') continue;
      counts.set(v, (counts.get(v) ?? 0) + r.count);
    }
    facets[key] = [...counts.entries()]
      .map(([v, count]) => ({ value: key === 'status' ? Number(v) : v, count }))
      .sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)))
      .slice(0, REQUEST_FACET_TOP);
  }
  return { total, facets, estimated: cube.estimated };
}

const patternLevel = (v: string | null): LogPatternLevel =>
  v === 'debug' || v === 'warn' || v === 'error' ? v : 'info';

/** `ctx.log` lines grouped by template: count, share, level split, and a small histogram. */
export function patternsFrom(
  cube: Cube<PatternCubeRow>,
  scope: {
    tenantId: string;
    scopeId?: string | undefined;
    from: number;
    to: number;
    buckets: number;
    grainMs: number;
    level?: readonly string[] | undefined;
    operation?: readonly string[] | undefined;
  },
): LogPatterns {
  const width = barWidth(scope.to - scope.from, scope.buckets, scope.grainMs);
  const rows = own(cube.rows, scope).filter(
    (r) =>
      (!scope.level?.length || scope.level.includes(patternLevel(r.level))) &&
      (!scope.operation?.length || (r.operation !== null && scope.operation.includes(r.operation))),
  );
  const total = rows.reduce((n, r) => n + r.count, 0);
  const byTemplate = new Map<string, { levels: Record<LogPatternLevel, number>; bars: Map<number, number> }>();
  for (const r of rows) {
    if (r.template === '') continue;
    let e = byTemplate.get(r.template);
    if (!e) {
      e = { levels: { debug: 0, info: 0, warn: 0, error: 0 }, bars: new Map() };
      byTemplate.set(r.template, e);
    }
    e.levels[patternLevel(r.level)] += r.count;
    const start = scope.from + Math.floor((r.bucket - scope.from) / width) * width;
    e.bars.set(start, (e.bars.get(start) ?? 0) + r.count);
  }
  const patterns: LogPattern[] = [...byTemplate.entries()]
    .map(([template, e]) => {
      const count = e.levels.debug + e.levels.info + e.levels.warn + e.levels.error;
      const dominant = (['error', 'warn', 'info', 'debug'] as const).reduce((best, l) =>
        e.levels[l] > e.levels[best] ? l : best,
      );
      return {
        template,
        count,
        share: total > 0 ? count / total : 0,
        levels: e.levels,
        dominant,
        buckets: [...e.bars.entries()].sort(([a], [b]) => a - b).map(([t, n]) => ({ start: new Date(t).toISOString(), count: n })),
      };
    })
    .sort((a, b) => b.count - a.count || a.template.localeCompare(b.template));
  return {
    total,
    bucketMs: width,
    patterns: patterns.slice(0, LOG_PATTERN_TOP),
    truncated: patterns.length > LOG_PATTERN_TOP,
    estimated: cube.estimated,
  };
}

/** Cubes for several services, as one — a tenant's app can be served by more than one. */
export function mergeCubes<R>(cubes: readonly Cube<R>[]): Cube<R> {
  return { rows: cubes.flatMap((c) => c.rows), estimated: cubes.some((c) => c.estimated) };
}

/** The window aligned outward to whole grains, so no grain is half in and half out. */
export function alignWindow(from: number, to: number, grainMs: number): { from: number; to: number } {
  return { from: Math.floor(from / grainMs) * grainMs, to: Math.ceil(to / grainMs) * grainMs };
}

/**
 * The scripts an aggregate read counts over — REQUIRED. A cube is counted per script family,
 * so there is no tenant-only fallback, and answering an absent list with empty counts would
 * read as "no traffic". The routes always resolve it; this refuses a caller that did not.
 */
function scriptsOf(services: readonly string[] | undefined): readonly string[] {
  if (services === undefined) {
    throw new Error("aggregate log reads need the app's script families (`services`) — a cube is counted per family");
  }
  return services;
}

/**
 * The three aggregate reads of `ObservabilityReader`, over any source (#1877). An adapter
 * binds its reads to this rather than computing them itself, so every source — the
 * telemetry query, a cache of it, a future store — answers with the same semantics, and
 * the contract suite holds one implementation to them.
 *
 * The histogram and the facet panel ask for the same cube (same window, same grain), so a
 * cached source answers a page's two reads from one block of counts.
 */
export function aggregateReads(
  source: AggregateSource,
): Required<Pick<ObservabilityReader, 'tenantRequestVolume' | 'tenantRequestFacets' | 'tenantLogPatterns'>> {
  const requestCube = async (input: TenantRequestScope) => {
    const services = scriptsOf(input.services);
    const grainMs = grainFor(input.to - input.from);
    const window = alignWindow(input.from, input.to, grainMs);
    const cube = mergeCubes(
      await Promise.all(services.map((service) => source.requests({ service, ...window, grainMs, tenantId: input.tenantId }))),
    );
    return { grainMs, window, cube };
  };
  return {
    async tenantRequestVolume(input) {
      const { grainMs, window, cube } = await requestCube(input);
      return volumeFrom(cube, { ...input, ...window, buckets: input.buckets, grainMs });
    },
    async tenantRequestFacets(input) {
      const { cube } = await requestCube(input);
      return facetsFrom(cube, input);
    },
    async tenantLogPatterns(input) {
      const services = scriptsOf(input.services);
      const grainMs = grainFor(input.to - input.from);
      const window = alignWindow(input.from, input.to, grainMs);
      const cube = mergeCubes(
        await Promise.all(services.map((service) => source.patterns({ service, ...window, grainMs }))),
      );
      return patternsFrom(cube, { ...input, ...window, grainMs });
    },
  };
}
