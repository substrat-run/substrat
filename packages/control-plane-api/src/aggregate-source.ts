/**
 * The aggregate half of the observability seam (#1877): counts, grouped by every facet,
 * for one deployed service and one span of time — and the cache that makes each span be
 * counted once.
 *
 * ## Why a second seam
 *
 * `ObservabilityReader` is the adapter the routes reach through, and its shapes are the
 * contract the dashboard reads. Underneath it, the request histogram, the facet counts
 * and the log patterns are all the same computation — sum a cube of counts — over a
 * source that could be a telemetry query, a cache of earlier answers, or a pre-aggregated
 * store. This file is that source, so the three reads are written once
 * (`aggregate-reads.ts`) and the way the counts are obtained can keep improving behind
 * them without the API moving.
 *
 * ## Why a cube, and why per service
 *
 * A source answers for a whole SERVICE (a deployed script) and every tenant it served,
 * grouped by every facet at once. A per-tenant answer would pay to scan the whole script's
 * lines to keep one tenant's; grouping by tenant in the same scan answers every tenant at
 * the price of one. And every facet in the grouping means any filter a panel produces is
 * summed from the cube in memory — ticking a value costs no query.
 *
 * The rows are therefore OTHER TENANTS' counts too. The reads filter to the caller's
 * tenant before anything leaves them, and the contract suite holds them to it.
 *
 * ## Why the cache is safe to keep forever
 *
 * Logs never change. A span of time that has closed — and has had long enough for late
 * lines to be ingested — has final counts, so its cube is kept for good and every later
 * reader of any tenant gets it without a query. Only the open span is read live.
 */

/** One row of the request cube: how many stamped invocation lines had these values. */
export interface RequestCubeRow {
  /** Start of the grain bucket, epoch milliseconds. */
  bucket: number;
  tenantId: string;
  scopeId: string | null;
  /** `null` for a line written before the field existed (#1746). */
  level: string | null;
  operation: string | null;
  problemCode: string | null;
  principalKind: string | null;
  surface: string | null;
  status: number | null;
  count: number;
}

/** One row of the pattern cube: how many `ctx.log` lines had these values (#1747). */
export interface PatternCubeRow {
  bucket: number;
  tenantId: string;
  scopeId: string | null;
  template: string;
  level: string | null;
  operation: string | null;
  count: number;
}

/** A cube and whether any of it was counted from a sample. */
export interface Cube<Row> {
  rows: Row[];
  /** The backend scaled a sample; the counts are estimates. */
  estimated: boolean;
}

/** What a source is asked: one service, one span, cut at one grain. */
export interface CubeQuery {
  /** The deployed script the lines came from — the scan boundary and the cache key. */
  service: string;
  /** Epoch milliseconds, inclusive / exclusive, aligned to `grainMs`. */
  from: number;
  to: number;
  grainMs: number;
}

/** A source of cubes. Implementations: the telemetry query, and a cache wrapping one. */
export interface AggregateSource {
  requests(q: CubeQuery): Promise<Cube<RequestCubeRow>>;
  patterns(q: CubeQuery): Promise<Cube<PatternCubeRow>>;
}

/** The grains a cube is cut at. Finer grains serve narrower windows. */
export const GRAINS_MS = [10_000, 60_000, 300_000, 3_600_000] as const;

/**
 * The grain for a window: the coarsest that still gives a zoomed histogram real
 * resolution. Fifteen minutes and under is cut into 10 s, two hours into a minute, a day
 * into five minutes, anything longer into hours — so a histogram of 90 bars never has
 * fewer than about 90 grains to draw them from, and a three-day window is 72 of them.
 */
export function grainFor(windowMs: number): number {
  if (windowMs <= 15 * 60_000) return 10_000;
  if (windowMs <= 2 * 3_600_000) return 60_000;
  if (windowMs <= 24 * 3_600_000) return 300_000;
  return 3_600_000;
}

/** A cached block is twelve grains: 2 min, 12 min, 1 h or 12 h. */
export function blockMsFor(grainMs: number): number {
  return grainMs * 12;
}

/** How long after a block ends before its counts are final — Workers Logs ingests late. */
export const CLOSE_LAG_MS = 5 * 60_000;

/** A stored block: its cube, as the source answered it. */
export interface StoredBlock<Row> {
  rows: Row[];
  estimated: boolean;
}

/** Where closed blocks live. Keys are opaque; a block, once written, never changes. */
export interface CubeStore {
  get(keys: readonly string[]): Promise<Map<string, StoredBlock<unknown>>>;
  put(key: string, block: StoredBlock<unknown>, blockStart: number): Promise<void>;
}

/** An in-memory store — the tests', and a harness without a Durable Object. */
export function memoryCubeStore(): CubeStore & { size(): number } {
  const blocks = new Map<string, StoredBlock<unknown>>();
  return {
    async get(keys) {
      const out = new Map<string, StoredBlock<unknown>>();
      for (const k of keys) {
        const b = blocks.get(k);
        if (b) out.set(k, b);
      }
      return out;
    },
    async put(key, block) {
      blocks.set(key, block);
    },
    size: () => blocks.size,
  };
}

/** The cache key of one block. The grain is in it: a block at 5 min is not one at 1 h. */
export function blockKey(kind: 'requests' | 'patterns', service: string, grainMs: number, start: number): string {
  return `${kind}|${service}|${grainMs}|${start}`;
}

/** How many uncached blocks one read computes at once — a bound on the backend's load. */
const BLOCK_CONCURRENCY = 4;

async function inBatches<T, R>(items: readonly T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

/**
 * A source that counts each closed block once.
 *
 * A query is split into blocks of twelve grains, aligned to the epoch so every reader
 * cuts the same blocks. A block that closed more than `CLOSE_LAG_MS` ago is read from the
 * store, or counted by `inner` and stored; the rest are counted live and not kept. Rows
 * outside the query's span are dropped, so a caller never sees the block edges.
 */
export function cachedSource(
  inner: AggregateSource,
  store: CubeStore,
  opts: { now?: () => number; lagMs?: number } = {},
): AggregateSource {
  const now = opts.now ?? (() => Date.now());
  const lag = opts.lagMs ?? CLOSE_LAG_MS;

  const read = async <Row extends { bucket: number }>(
    kind: 'requests' | 'patterns',
    q: CubeQuery,
    count: (q: CubeQuery) => Promise<Cube<Row>>,
  ): Promise<Cube<Row>> => {
    const blockMs = blockMsFor(q.grainMs);
    const first = Math.floor(q.from / blockMs) * blockMs;
    const starts: number[] = [];
    for (let s = first; s < q.to; s += blockMs) starts.push(s);
    const closedBefore = now() - lag;
    const closed = starts.filter((s) => s + blockMs <= closedBefore);
    const open = starts.filter((s) => s + blockMs > closedBefore);

    const keys = closed.map((s) => blockKey(kind, q.service, q.grainMs, s));
    const found = await store.get(keys);
    const missing = closed.filter((_, i) => !found.has(keys[i]!));
    const counted = await inBatches(missing, BLOCK_CONCURRENCY, async (s) => {
      const block = await count({ service: q.service, from: s, to: s + blockMs, grainMs: q.grainMs });
      await store.put(blockKey(kind, q.service, q.grainMs, s), block, s);
      return block;
    });
    // The open blocks as ONE live span: they are contiguous, and one query is cheaper
    // than several short ones.
    const live =
      open.length > 0
        ? await count({ service: q.service, from: open[0]!, to: open[open.length - 1]! + blockMs, grainMs: q.grainMs })
        : { rows: [] as Row[], estimated: false };

    const blocks = [...[...found.values()].map((b) => b as StoredBlock<Row>), ...counted, live];
    return {
      rows: blocks.flatMap((b) => b.rows).filter((r) => r.bucket >= q.from && r.bucket < q.to),
      estimated: blocks.some((b) => b.estimated),
    };
  };

  return {
    requests: (q) => read('requests', q, (b) => inner.requests(b)),
    patterns: (q) => read('patterns', q, (b) => inner.patterns(b)),
  };
}
