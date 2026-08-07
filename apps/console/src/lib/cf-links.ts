import type { BlobStoreRecord, TenantStoreRecord } from '@substrat-run/kernel';

/**
 * Cloudflare dashboard deep links — the console's answer to "which DO is this, and which
 * database holds this tenant's rows?".
 *
 * The console already renders every identifier an operator needs (`servingRef`, a store's
 * `ref`, the scope id a DO is named after). What it could not do is say WHERE those
 * resolve, which left staff pasting ids into the dashboard's search box. The control
 * plane now hands over the account + dispatch namespace (`GET /platform/runtime`), and
 * this module is the ONE place that turns a (runtime, ref) pair into a URL.
 *
 * That concentration is the point: dashboard URL shapes are Cloudflare's, undocumented
 * below the section level, and free to change. Every builder below returns `null` rather
 * than a guess when the runtime is absent or the ref is empty — a missing link renders as
 * a plain identifier (exactly today's behaviour), never as a link that 404s.
 */

/** Where the platform's compute and stores live — mirrors control-plane-api's
 *  `PlatformRuntime` (declared here so the console keeps its own vocabulary, the same
 *  precedent as `ServiceMetricsRow`). */
export interface PlatformRuntime {
  provider: 'cloudflare';
  accountId: string;
  dispatchNamespace: string;
}

/** The tenant's platform-minted stores, as the console reads them (#301, #473). */
export interface TenantStores {
  tenantStores: TenantStoreRecord[];
  blobStores: BlobStoreRecord[];
}

const DASH = 'https://dash.cloudflare.com';

/**
 * The account-relative paths, pinned in one table — verified against the dashboard
 * 2026-08-07. Cloudflare documents only the section-level forms (`?to=/:account/workers/d1`,
 * `…/workers/durable-objects`, `…/workers/services/view/:worker/production/settings`); the
 * resource-level forms below are observed. Keeping them in one table means a dashboard
 * reshuffle is a one-line fix, not a hunt through views.
 *
 * Each lands on the resource's default tab: the dashboard appends its own (`/metrics`,
 * `/overview`), and pinning a tab here would make every link an opinion about what an
 * operator came to look at.
 */
const PATHS = {
  d1Database: (id: string) => `workers/d1/databases/${encodeURIComponent(id)}`,
  r2Bucket: (name: string) => `r2/default/buckets/${encodeURIComponent(name)}`,
  dispatchScript: (ns: string, script: string) =>
    `workers-for-platforms/namespaces/${encodeURIComponent(ns)}/scripts/${encodeURIComponent(script)}`,
  workerService: (name: string) => `workers/services/view/${encodeURIComponent(name)}/production`,
  durableObjects: () => 'workers/durable-objects',
  /** One DO namespace, addressed by the id Cloudflare assigns it — NOT the class or script
   *  name. Only linkable once something resolves that id (see `doNamespaceUrl`). */
  durableObjectNamespace: (id: string) => `workers/durable-objects/view/${encodeURIComponent(id)}`,
} as const;

function dashUrl(runtime: PlatformRuntime | null, path: string): string | null {
  // A runtime that is not Cloudflare has no dashboard we know the shape of; a self-host
  // deployment has none at all. Both degrade to "no link", never to a wrong one.
  if (!runtime || runtime.provider !== 'cloudflare' || !runtime.accountId) return null;
  return `${DASH}/${runtime.accountId}/${path}`;
}

/** One pushed vertical's script in the dispatch namespace — what a scope's `servingRef`
 *  (or a version's `deploymentRef`) names. The script's own page carries its bindings,
 *  logs and Durable Object namespaces, so this is the single most useful link staff have:
 *  it is the door to the code AND the data for one scope. */
export function dispatchScriptUrl(runtime: PlatformRuntime | null, script: string | null | undefined) {
  if (!script) return null;
  return dashUrl(runtime, PATHS.dispatchScript(runtime?.dispatchNamespace ?? '', script));
}

/** A platform-owned Worker (the control plane, the router) — not a namespace script. */
export function workerServiceUrl(runtime: PlatformRuntime | null, name: string | null | undefined) {
  if (!name) return null;
  return dashUrl(runtime, PATHS.workerService(name));
}

/** One per-tenant D1 database, addressed by the ledger `ref` (which IS the database id). */
export function d1DatabaseUrl(runtime: PlatformRuntime | null, databaseId: string | null | undefined) {
  if (!databaseId) return null;
  return dashUrl(runtime, PATHS.d1Database(databaseId));
}

/** One per-tenant R2 bucket, addressed by the ledger `ref` (which IS the bucket name). */
export function r2BucketUrl(runtime: PlatformRuntime | null, bucket: string | null | undefined) {
  if (!bucket) return null;
  return dashUrl(runtime, PATHS.r2Bucket(bucket));
}

/** The Durable Objects list — the fallback when the namespace id cannot be resolved
 *  (no lookup configured, or the read failed). One entry per pushed script on a real
 *  fleet, which is why it is the fallback and not the target. */
export function durableObjectsUrl(runtime: PlatformRuntime | null) {
  return dashUrl(runtime, PATHS.durableObjects());
}

/** One Durable Object namespace, addressed by the id `GET /platform/do-namespaces`
 *  resolves. There is still no per-OBJECT page in the dashboard — this lands on the
 *  namespace the scope's object lives in, which is as close as the provider allows. */
export function doNamespaceUrl(runtime: PlatformRuntime | null, namespaceId: string | null | undefined) {
  if (!namespaceId) return null;
  return dashUrl(runtime, PATHS.durableObjectNamespace(namespaceId));
}

/** One Durable Object namespace as the control plane reports it. */
export interface DoNamespace {
  id: string;
  className: string;
  script: string | null;
  name: string | null;
  useSqlite: boolean;
}

/**
 * The name the scope's Durable Object is derived from — `SCOPE.idFromName(scopeId)` in
 * the adapter (`host.ts` scopeStub). Not the hex object id: that is a hash Cloudflare
 * computes, so the name is the only handle a human can carry into the dashboard.
 */
export function scopeDoName(scopeId: string): string {
  return scopeId;
}

/** The stores backing one scope: the tenant's ledger rows narrowed to the vertical the
 *  scope runs. A scope whose vertical declares no stores yields empty lists. */
export function storesForScope(
  stores: TenantStores | null,
  vertical: string | null,
): TenantStores {
  if (!stores || !vertical) return { tenantStores: [], blobStores: [] };
  return {
    tenantStores: stores.tenantStores.filter((s) => s.vertical === vertical),
    blobStores: stores.blobStores.filter((s) => s.vertical === vertical),
  };
}
