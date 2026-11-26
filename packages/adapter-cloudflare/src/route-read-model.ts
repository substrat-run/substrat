/**
 * The routing read model (#3395): what the router needs to dispatch a hostname, published by the
 * control plane to Workers KV, so a request does not have to reach the directory object.
 *
 * Two kinds of entry, split by how they change:
 *
 * - **A route** (`h/<hostname>`): tenant, scope, vertical, surface, the scope's hostnames, whether
 *   it is the real install (#2005), and a dispatch pointer. It changes when a hostname, a scope's
 *   binding or a lifecycle status changes.
 * - **A vertical's serving policy** (`v/<slug>`): the outbound hosts, peer calls and scope stores
 *   of the version the vertical's stable serving script runs (K-33, D-46). A promote moves this one
 *   key and no route. A scope still on a per-version script carries its version's policy inline
 *   instead, because that policy is fixed for the version.
 *
 * The manifest fields travel as the JSON text the directory's own read extracts
 * (`READ_ROUTE_SQL`), so an entry assembles into a `RouteRowLike` that `toRouteTarget` parses
 * exactly as it parses the directory's answer: one parser, never two.
 *
 * Only plain data is cached here. A Durable Object stub is never held beyond the request that
 * created it (see `createRouteResolver`), and nothing in this module holds one at all.
 *
 * This file is the router's half and depends on contracts alone, like the rest of the routing
 * entry. The control plane's half (what writes the entries) is `route-read-model-publisher.ts`.
 */
import type { RouteRowLike } from './route-resolver.js';

/** Bumped when an entry's shape changes incompatibly: a reader never meets an entry it cannot read. */
export const ROUTE_READ_MODEL_VERSION = 1;
const PREFIX = `route/v${ROUTE_READ_MODEL_VERSION}/`;

/** The KV key of a hostname's route. Hostnames are stored lowercased (`normalizeHostname`). */
export const routeKvKey = (hostname: string): string => `${PREFIX}h/${hostname}`;
/** The KV key of a vertical's serving policy. A slug may itself hold a `/` (`<tenant>/<slug>`). */
export const servingPolicyKvKey = (slug: string): string => `${PREFIX}v/${slug}`;

/** A version's dispatch parameters, as JSON text from its manifest (null = not declared). */
export interface PolicyFields {
  outbound_json: string | null;
  calls_json: string | null;
  scope_stores_json: string | null;
}

/** `v/<slug>`: what the vertical's stable serving script runs. */
export interface ServingPolicyEntry extends PolicyFields {
  v: typeof ROUTE_READ_MODEL_VERSION;
  /** `verticals.serving_ref`: a scope on THIS script takes the serving version's stores. */
  serving_ref: string | null;
}

/**
 * `h/<hostname>` for a hostname that is itself active but does not route, because its scope or
 * its tenant is not active (suspended, archived, deleting) — or the pair no longer matches. The
 * router refuses it from KV, so a suspended tenant's traffic does not fall back to the directory.
 * A hostname that is not active itself (pending, failed, removed) has no entry at all: a miss,
 * which the directory answers at once, so a newly activated hostname is never held up by a
 * refusal cached at the edge.
 */
export interface RefusedRouteEntry {
  v: typeof ROUTE_READ_MODEL_VERSION;
  refused: true;
}

/** `h/<hostname>`: one routable hostname. */
export interface RouteEntry {
  v: typeof ROUTE_READ_MODEL_VERSION;
  tenant_id: string;
  scope_id: string;
  vertical_slug: string | null;
  surface: string;
  /** Always null: a region-pinned route is never published (K-36). Kept so the row is whole. */
  region: string | null;
  primary: boolean;
  scope_hostnames: string[];
  /**
   * Where the dispatch goes and whose policy it runs under:
   * - `serving`: the scope's data lives in a stable serving script (`scopes.serving_ref`). The
   *   policy is the vertical's serving version's, read from `v/<vertical>`; `vertical` null means
   *   the scope names no vertical, and the policy is all null, as the directory's join gives it.
   * - `version`: a legacy scope on its bound version's own script, with that version's policy.
   * - `none`: nothing to dispatch to (`deployment_ref` null).
   */
  dispatch:
    | { kind: 'serving'; ref: string; vertical: string | null }
    | ({ kind: 'version'; ref: string | null } & PolicyFields)
    | { kind: 'none' };
}

const NULL_POLICY: PolicyFields = { outbound_json: null, calls_json: null, scope_stores_json: null };

/**
 * A route entry and, for a `serving` dispatch, its vertical's serving policy → the row the
 * directory's `readRoute` would have answered. `undefined` when the serving policy is needed and
 * absent: the caller then asks the directory rather than guessing.
 */
export function assembleRouteRow(
  route: RouteEntry,
  serving: ServingPolicyEntry | null | undefined,
): RouteRowLike | undefined {
  let deployment_ref: string | null;
  let policy: PolicyFields;
  const d = route.dispatch;
  if (d.kind === 'serving') {
    deployment_ref = d.ref;
    if (d.vertical === null) {
      policy = NULL_POLICY;
    } else {
      if (!serving) return undefined;
      // `READ_ROUTE_SQL`: outbound and calls from the serving version; the stores only when the
      // scope runs the vertical's CURRENT serving script (#2207), none on any other.
      policy = {
        outbound_json: serving.outbound_json,
        calls_json: serving.calls_json,
        scope_stores_json: d.ref === serving.serving_ref ? serving.scope_stores_json : null,
      };
    }
  } else if (d.kind === 'version') {
    deployment_ref = d.ref;
    policy = { outbound_json: d.outbound_json, calls_json: d.calls_json, scope_stores_json: d.scope_stores_json };
  } else {
    deployment_ref = null;
    policy = NULL_POLICY;
  }
  return {
    tenant_id: route.tenant_id,
    scope_id: route.scope_id,
    vertical_slug: route.vertical_slug,
    surface: route.surface,
    region: route.region,
    deployment_ref,
    ...policy,
    primary: route.primary,
    scope_hostnames: route.scope_hostnames,
  };
}

/** Structural checks only: an entry this code cannot read is a miss, never a wrong route. */
export function isRouteEntry(value: unknown): value is RouteEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Partial<RouteEntry>;
  return (
    e.v === ROUTE_READ_MODEL_VERSION &&
    typeof e.tenant_id === 'string' &&
    typeof e.scope_id === 'string' &&
    typeof e.surface === 'string' &&
    typeof e.primary === 'boolean' &&
    Array.isArray(e.scope_hostnames) &&
    typeof e.dispatch === 'object' &&
    e.dispatch !== null &&
    ['serving', 'version', 'none'].includes((e.dispatch as { kind: string }).kind)
  );
}

export function isRefusedRouteEntry(value: unknown): value is RefusedRouteEntry {
  return (
    typeof value === 'object' && value !== null &&
    (value as { v?: unknown }).v === ROUTE_READ_MODEL_VERSION && (value as { refused?: unknown }).refused === true
  );
}

export function isServingPolicyEntry(value: unknown): value is ServingPolicyEntry {
  return typeof value === 'object' && value !== null && (value as { v?: unknown }).v === ROUTE_READ_MODEL_VERSION;
}

// ---------------------------------------------------------------------------
// The router's read: memory → KV → the directory
// ---------------------------------------------------------------------------

/** The slice of a KV binding the router reads through. */
export interface RouteKvReader {
  get(key: string, options: { type: 'json'; cacheTtl?: number }): Promise<unknown>;
}

/**
 * The cache split (K-72, under D-77's five-minute bound, proposed in #3396). The owner ranks
 * request latency and cost above freshness, so the defaults are the cheapest that stay inside it:
 *
 *   publish (under a second) + KV's edge cache (60 s) + this memory (180 s) ≈ 4 minutes,
 *
 * which leaves about a minute for KV propagating beyond its own cache TTL ("60 seconds or more").
 * KV bills every `get`, so a longer memory TTL is fewer billed reads: an isolate reads a route and
 * its vertical's policy at most once per TTL each. A refusal is kept as long as a route.
 *
 * A negative answer (no entry, and the directory routes nothing) is kept 60 s. It only delays a
 * hostname activated in the minute after the same isolate was asked for it, and it bounds how often
 * an unknown name probed in a loop reaches the directory.
 */
export const ROUTE_MEMORY_TTL_MS = 180_000;
export const ROUTE_NEGATIVE_TTL_MS = 60_000;
/** KV's edge cache for a read (seconds): its default. 30 is the minimum KV accepts. */
export const ROUTE_KV_CACHE_TTL_S = 60;
/** Entries one isolate keeps, oldest dropped first. A route is a few hundred bytes. */
export const ROUTE_MEMORY_MAX_ENTRIES = 10_000;

interface Cached {
  value: unknown;
  until: number;
}

/**
 * One isolate's memory of KV entries and directory answers, keyed by KV key. Holds plain data
 * only (parsed JSON and rows), so it is safe to keep across requests at module scope.
 */
export class RouteMemoryCache {
  private readonly entries = new Map<string, Cached>();
  constructor(private readonly maxEntries = ROUTE_MEMORY_MAX_ENTRIES) {}

  get(key: string, now: number): { value: unknown } | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.until <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return { value: hit.value };
  }

  set(key: string, value: unknown, until: number): void {
    this.entries.delete(key);
    this.entries.set(key, { value, until });
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Where a resolution came from, for the comparison mode's log and the tests. */
export type RouteReadSource = 'memory' | 'kv' | 'directory';

export interface ReadModelRouteReaderOptions {
  kv: RouteKvReader;
  cache: RouteMemoryCache;
  now?: () => number;
  memoryTtlMs?: number;
  negativeTtlMs?: number;
  kvCacheTtlSeconds?: number;
}

/** The control-plane directory's read, as the resolver falls back to it. */
export type DirectoryRouteRead = (hostname: string) => Promise<RouteRowLike | undefined>;

/**
 * The read model's answer for a NORMALIZED hostname, from memory or KV alone: a row, `undefined`
 * for a refused route, or `'miss'` when only the directory can answer. Never asks the directory,
 * so the comparison mode can call it beside the directory's read without doubling it.
 */
export function readModelRouteReader(opts: ReadModelRouteReaderOptions) {
  const now = opts.now ?? Date.now;
  const ttl = opts.memoryTtlMs ?? ROUTE_MEMORY_TTL_MS;
  const cacheTtl = opts.kvCacheTtlSeconds ?? ROUTE_KV_CACHE_TTL_S;

  const entry = async (key: string): Promise<unknown> => {
    const at = now();
    const hit = opts.cache.get(key, at);
    if (hit) return hit.value;
    const value = (await opts.kv.get(key, { type: 'json', cacheTtl })) ?? null;
    // Only a found entry is kept: a KV miss is answered by the directory, which is kept below.
    if (value !== null) opts.cache.set(key, value, at + ttl);
    return value;
  };

  return async (hostname: string): Promise<RouteRowLike | undefined | 'miss'> => {
    const route = await entry(routeKvKey(hostname));
    if (isRefusedRouteEntry(route)) return undefined;
    if (!isRouteEntry(route)) return 'miss';
    let serving: ServingPolicyEntry | undefined;
    if (route.dispatch.kind === 'serving' && route.dispatch.vertical !== null) {
      const policy = await entry(servingPolicyKvKey(route.dispatch.vertical));
      if (!isServingPolicyEntry(policy)) return 'miss';
      serving = policy;
    }
    return assembleRouteRow(route, serving) ?? 'miss';
  };
}

/**
 * Memory → KV → the directory, for a NORMALIZED hostname. The directory answers every miss, and
 * its answer is kept in memory briefly (a negative one too), so an unknown hostname probed in a
 * loop asks the directory once per isolate per `negativeTtlMs`, not once per request.
 */
export function readModelRouteRead(
  opts: ReadModelRouteReaderOptions & { directory: DirectoryRouteRead },
): (hostname: string) => Promise<{ row: RouteRowLike | undefined; source: RouteReadSource }> {
  const now = opts.now ?? Date.now;
  const fromModel = readModelRouteReader(opts);
  const answerKey = (hostname: string) => `answer:${hostname}`;
  return async (hostname) => {
    const remembered = opts.cache.get(answerKey(hostname), now());
    if (remembered) return { row: (remembered.value as RouteRowLike | null) ?? undefined, source: 'memory' };
    let modelled: RouteRowLike | undefined | 'miss';
    try {
      modelled = await fromModel(hostname);
    } catch {
      // KV unavailable is a slower request, never a refused one.
      modelled = 'miss';
    }
    if (modelled !== 'miss') return { row: modelled, source: 'kv' };
    const row = await opts.directory(hostname);
    const at = now();
    opts.cache.set(
      answerKey(hostname),
      row ?? null,
      at + (row ? (opts.memoryTtlMs ?? ROUTE_MEMORY_TTL_MS) : (opts.negativeTtlMs ?? ROUTE_NEGATIVE_TTL_MS)),
    );
    return { row, source: 'directory' };
  };
}
