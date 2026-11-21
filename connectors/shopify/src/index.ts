import {
  CONNECTION_BINDING_SKIPPED_LISTED,
  commerceChange,
  connectionActivity,
  connectionBindingHealth,
  connectionBindingIssue,
  connectionId as connectionIdSchema,
  currencyCode,
  instant,
  scopeId as scopeIdSchema,
  tenantId as tenantIdSchema,
  type ConnectionActivity,
  type ConnectionBindingHealth,
  type ConnectionCredential,
  type ConnectionProbe,
  type ConnectionId,
  type CurrencyCode,
  type Instant,
  type OpenConnection,
  type z,
} from '@substrat-run/contracts';
import type { ConnectorConnection, FetchLike, HostAdmin, InvokeOptions, ScopeHost, ScopeStub } from '@substrat-run/kernel';
import { deadlineFetch, landingRefusalSaid, settleConnectionUse } from '@substrat-run/kernel';
import {
  ShopifyApi,
  ShopifyApiError,
  SHOPIFY_NODES_PAGE,
  SHOPIFY_REQUIRED_SCOPES,
  idOfGid,
  shopifyOrder,
  shopifyProduct,
  shopifySecret,
  type ShopifyOrder,
  type ShopifyProduct,
  type ShopifyResource,
  type ShopifySecret,
  type ShopifyShopInfo,
} from './api.js';
import { orderChange, productChange, updatedAtOf } from './commerce.js';
import { shopDomain, ShopDomainError } from './shop-domain.js';
import { SeenIds } from './seen.js';
import { RowFailures, verdictOf, SHOPIFY_ROW_ATTEMPTS, ShopifyRowStall, type ShopifyRowFailure } from './failures.js';

export {
  ShopifyApi,
  ShopifyApiError,
  SHOPIFY_API_VERSION,
  SHOPIFY_NESTED_PAGE,
  SHOPIFY_NODES_PAGE,
  SHOPIFY_ORDERS_PAGE,
  SHOPIFY_PRODUCTS_PAGE,
  SHOPIFY_REQUIRED_SCOPES,
  gidOf,
  idOfGid,
  shopifySecret,
  type ShopifyApiOptions,
  type ShopifySecret,
  type ShopifyOrder,
  type ShopifyProduct,
  type ShopifyVariant,
  type ShopifyLineItem,
} from './api.js';
export { orderChange, productChange, shopifyInstant, ShopifyMappingError } from './commerce.js';
export { shopDomain, ShopDomainError } from './shop-domain.js';
export { SEEN_BUCKETS } from './seen.js';
export { SHOPIFY_MAX_SKIPPED, SHOPIFY_ROW_ATTEMPTS, SHOPIFY_SKIPPED_RETRIES, ShopifyRowStall, type ShopifyRowFailure } from './failures.js';
export { ShopifyMock, type ShopifyMockOptions, type MockOrder, type MockProduct } from './mock.js';

/**
 * The Shopify connector — a shop's products and orders, landed in a scope in the provider-neutral
 * commerce shape (`commerceChange` in `@substrat-run/contracts`, #3136), the same shape and through
 * the same kind of landing operation as the WooCommerce connector's. A vertical written against one
 * lands the other's records unchanged; what stays Shopify's is the connection — the shop, the app's
 * client credentials, the probe.
 *
 * Modelled on `connectors/woocommerce` section by section, so the two read side by side. Where they
 * differ, it is because Shopify does:
 *
 * ## The credential is a Dev Dashboard app's client ID and secret
 *
 * The merchant creates an app in Shopify's Dev Dashboard, gives it the read scopes, installs it on
 * their shop, and pastes the shop, the client ID and the client secret. Each pass mints a short-lived
 * access token from them (OAuth client credentials) and keeps it in memory only; see `src/api.ts`.
 *
 * ## Poll-only, read-only
 *
 * As WooCommerce: nothing inside a scope asks for an order, so no dispatch, and
 * {@link sweepShopify} is the whole trigger surface. Every query is a read; the app needs
 * `read_products` and `read_orders`, and is refused at connect time without them.
 *
 * ## The sync is a keyset walk over `updated_at`
 *
 * Products and orders are each read oldest change first (`sortKey: UPDATED_AT`), filtered to
 * `updated_at:>='<cursor − 1 s>'`, and skipping the ids already landed at the cursor's second — the
 * WooCommerce walk's cursor, for the same reason. Within a pass the walk follows Shopify's own
 * GraphQL cursors, which are keyset cursors over the same sort key, so a record saved mid-walk moves
 * behind the walk and is met again rather than shifting another out of sight. A pass that stops at
 * its page budget keeps the GraphQL cursor it stopped at (`resume`), so a bulk edit that saves
 * thousands of products in one second is walked in order across passes instead of re-read from the
 * top each time.
 *
 * **A change younger than {@link SHOPIFY_SETTLE_MS} is left for the next pass.** Shopify answers a
 * filtered list from its search index, which can lag a write by seconds. A walk that landed a row
 * saved at T+5 s before the index held one saved at T would move its cursor past T and never see the
 * first. Leaving the last two minutes to the next pass costs that much freshness and closes the gap.
 *
 * ## What it does NOT see, and says so
 *
 * - **A stock change that does not save the product.** Stock rides on the product row, as
 *   WooCommerce's does, and is fresh only if a sale or an adjustment moves the product's
 *   `updatedAt`. WooCommerce's live test proves that for WooCommerce; whether Shopify's inventory
 *   writes do is NOT yet verified, and an inventory walk of its own is the fix if they do not.
 * - **Orders older than 60 days, without `read_all_orders`.** Shopify hides them from an app without
 *   that scope, silently. The probe says which a connection has (`Order history`), and the reconcile
 *   leaves orders alone without it (below).
 *
 * ## Deletes: a reconcile pass over what was delivered
 *
 * As WooCommerce's (#3224), with Shopify's simpler ground truth: there is no trash, and `nodes(ids:)`
 * answers `null` for an id the shop does not hold, so once per {@link SHOPIFY_RECONCILE_EVERY_MS}
 * the connector asks about every id it delivered, a hundred at a time, and reports each missing one
 * as `removed` / `deleted`. **Orders are reconciled only when the app holds `read_all_orders`**:
 * without it an order turns invisible at 60 days old, which `nodes` cannot tell from a delete, and
 * reporting it would tell a vertical that a real order was deleted.
 *
 * ## Where the data lands, one record never holds the walk, a connection is one shop
 *
 * All as WooCommerce's: {@link bindShopifyScope} names the scope, the operation and its permission
 * and refuses a binding whose connection lacks it; a record that cannot land is waited at for
 * {@link SHOPIFY_ROW_ATTEMPTS} passes then skipped, and retried on the reconcile cadence; a
 * connection is keyed on the shop its probe names (`<handle>.myshopify.com`), and a scope may own
 * its shop's connection (`owner: 'scope'`, #3201).
 */

/**
 * The standing grants this connector requires — deliberately empty, for WooCommerce's reason: the
 * permission is whatever the consumer's landing operation checks, so it is verified at bind time.
 */
export const SHOPIFY_CONNECTION_GRANTS = [] as const;

/** How often a binding's delivered ids are reconciled against the shop — every fourth 15-minute pass. */
export const SHOPIFY_RECONCILE_EVERY_MS = 60 * 60 * 1000;

/** How many pages of each resource one sync lands at most. */
export const SHOPIFY_PAGES_PER_SYNC = 20;

/** Changes younger than this are left for the next pass, for Shopify's search index to catch up. */
export const SHOPIFY_SETTLE_MS = 2 * 60 * 1000;

const BINDING_PREFIX = 'shopify:binding:';
const bindingKey = (scope: string): string => `${BINDING_PREFIX}${scope}`;

/**
 * Where a resource's walk stands: the last change landed, the ids landed at that second, and — when
 * the last pass stopped at its page budget — the query bound and GraphQL cursor it stopped at.
 */
export interface ShopifyCursor {
  at: string | null;
  landedAt: string[];
  resume?: { from: string | null; after: string };
}

export interface ShopifyBinding {
  scopeId: string;
  tenantId: string;
  vertical: string;
  /** The operation each `commerceChange` lands through — the vertical's, named by whoever binds. */
  operation: string;
  /** The permission `operation` checks, which the connection must hold on `scopeId`. */
  permission: string;
  /** WHICH shop's connection this is: the connection's `externalAccountRef`, its `myshopify.com` name. */
  externalAccountRef?: string | null;
  /** The scope that OWNS this connection (#3201), for a scope's own connection. */
  ownerScopeId?: string | null;
  boundAt: string;
  lastSync?: {
    syncedAt: string;
    products: ShopifyCursor;
    orders: ShopifyCursor;
    /** False when a pass stopped at its page budget with changes still to read. */
    caughtUp: boolean;
    landed: { products: number; orders: number; removed: number };
    /** When the delivered ids were last reconciled in full; absent until the first time. */
    reconciledAt?: string;
    /** False when the app lacks `read_all_orders`, so deleted orders are not reported. */
    ordersReconciled?: boolean;
    stalled?: ShopifyRowFailure[];
    skipped?: ShopifyRowFailure[];
  };
}

export interface ShopifyConnectorOptions {
  fetch: FetchLike;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Pages per resource per sync; {@link SHOPIFY_PAGES_PER_SYNC} by default. */
  pagesPerSync?: number;
  /** How often delivered ids are reconciled; {@link SHOPIFY_RECONCILE_EVERY_MS} by default. */
  reconcileEveryMs?: number;
  /** How young a change is left for the next pass; {@link SHOPIFY_SETTLE_MS} by default. */
  settleMs?: number;
}

/** Declare that a connection syncs one scope. Refuses a binding whose grant is missing. */
export async function bindShopifyScope(
  host: ScopeHost,
  input: {
    connectionId: ConnectionId;
    tenantId: string;
    scopeId: string;
    vertical: string;
    operation: string;
    permission: string;
    externalAccountRef?: string | null;
    ownerScopeId?: string | null;
    /** Internal automatic-pass path: the declaration was checked and its grant follows this write. */
    grantPreflighted?: boolean;
    now?: () => number;
  },
): Promise<ShopifyBinding> {
  const tenant = tenantIdSchema.parse(input.tenantId);
  const scope = scopeIdSchema.parse(input.scopeId);
  if (input.ownerScopeId && input.ownerScopeId !== input.scopeId) {
    throw new Error(`connection ${input.connectionId} is scope ${input.ownerScopeId}'s own, and lands in that scope alone, not ${input.scopeId}`);
  }
  const granted = input.grantPreflighted ? [] : await host.connectionGrantsInScope(tenant, scope);
  const held =
    input.grantPreflighted ||
    granted.some((g: { connectionId: string; permission: string }) => g.connectionId === input.connectionId && g.permission === input.permission);
  if (!held) {
    throw new Error(
      `connection ${input.connectionId} does not hold '${input.permission}' on scope ${input.scopeId} — ` +
        `a sweep would read the shop and then fail to land it. Grant it first (grantToConnection), then bind.`,
    );
  }
  const binding: ShopifyBinding = {
    scopeId: input.scopeId,
    tenantId: input.tenantId,
    vertical: input.vertical,
    operation: input.operation,
    permission: input.permission,
    ...(input.externalAccountRef ? { externalAccountRef: input.externalAccountRef } : {}),
    ...(input.ownerScopeId ? { ownerScopeId: input.ownerScopeId } : {}),
    boundAt: new Date(input.now?.() ?? Date.now()).toISOString(),
  };
  await host.admin.putConnectorState(input.connectionId, bindingKey(input.scopeId), binding);
  return binding;
}

/** Every scope this connection syncs into. Tombstones are left out. */
export async function listShopifyBindings(host: ScopeHost, connectionId: ConnectionId): Promise<ShopifyBinding[]> {
  const rows = await host.admin.listConnectorState(connectionId, BINDING_PREFIX);
  return rows.filter((r) => r.value !== null && typeof r.value === 'object').map((r) => r.value as ShopifyBinding);
}

const issueOf = (f: ShopifyRowFailure): z.input<typeof connectionBindingIssue> => ({
  record: f.resource === 'products' ? 'product' : 'order',
  recordId: String(f.id),
  message: f.error,
  firstFailedAt: f.firstFailedAt,
  failedAt: f.failedAt,
  attempts: f.attempts,
});

/** How one binding fares, in the platform's shape. What a scope's `listBindings` reads. */
export function shopifyBindingHealth(binding: ShopifyBinding): ConnectionBindingHealth {
  const s = binding.lastSync;
  const skipped = [...(s?.skipped ?? [])].sort((a, b) => (a.failedAt < b.failedAt ? -1 : a.failedAt > b.failedAt ? 1 : 0));
  return connectionBindingHealth.parse({
    caughtUp: s ? s.caughtUp : null,
    stalled: (s?.stalled ?? []).map(issueOf),
    skipped: skipped.slice(0, CONNECTION_BINDING_SKIPPED_LISTED).map(issueOf),
    skippedTotal: skipped.length,
  });
}

/** Stop syncing one scope (a tombstone, as for every connector-state row). */
export async function unbindShopifyScope(host: ScopeHost, connectionId: ConnectionId, scopeId: string): Promise<void> {
  await host.admin.putConnectorState(connectionId, bindingKey(scopeId), null);
}

export interface ShopifySyncResult {
  scopeId: string;
  /** False when nothing had changed at the shop since the last sync — nothing was landed. */
  changed: boolean;
  products: number;
  orders: number;
  removed: number;
  caughtUp: boolean;
  skipped: number;
}

/** `at` minus one second, as Shopify's search takes a time. */
function secondBefore(at: string): string {
  return `${new Date(Date.parse(at) - 1000).toISOString().slice(0, 19)}Z`;
}

interface Walk {
  cursor: ShopifyCursor;
  landed: number;
  caughtUp: boolean;
}

interface ReadRow<T> {
  id: number;
  at: Instant | null;
  row: T | null;
  error?: unknown;
}

const GID_TYPE: Record<ShopifyResource, string> = { products: 'Product', orders: 'Order' };

function readRow<T extends { id: string; updatedAt: string }>(raw: unknown, resource: ShopifyResource, parse: (row: unknown) => T): ReadRow<T> {
  const what = resource === 'products' ? 'product' : 'order';
  const r = (raw ?? {}) as { id?: unknown; updatedAt?: unknown };
  const id = typeof r.id === 'string' ? idOfGid(r.id, GID_TYPE[resource]) : null;
  // A row with no id cannot be placed or named at all.
  if (id === null) throw new ShopifyApiError(`a ${what} in the changed list carries no ${GID_TYPE[resource]} id`, 502);
  let row: T;
  try {
    row = parse(raw);
  } catch (error) {
    let at: Instant | null = null;
    try {
      if (typeof r.updatedAt === 'string') at = updatedAtOf({ id: String(r.id), updatedAt: r.updatedAt }, what);
    } catch {
      // No readable date either: it is recorded, and the cursor does not move for it.
    }
    return { id, at, row: null, error };
  }
  try {
    return { id, at: updatedAtOf(row, what), row };
  } catch (error) {
    return { id, at: null, row: null, error };
  }
}

/**
 * Walk one resource from its cursor, landing each fresh row through `land` in change order, and
 * stopping at the first row younger than `until`. The cursor in `walk` is advanced after each landed
 * or skipped row, and its `resume` set to the page the walk is on, so a stall or the page budget
 * leaves the next pass where this one stopped.
 */
async function walkChanged<T extends { id: string; updatedAt: string }>(
  api: ShopifyApi,
  resource: ShopifyResource,
  parse: (row: unknown) => T,
  land: (row: T) => Promise<boolean>,
  failures: RowFailures,
  operation: string,
  walk: Walk,
  pages: number,
  until: string,
  customers: boolean,
): Promise<void> {
  const resume = walk.cursor.resume;
  const from = resume ? resume.from : walk.cursor.at === null ? null : secondBefore(walk.cursor.at);
  let after: string | null = resume ? resume.after : null;
  for (let request = 0; request < pages; request += 1) {
    // Kept on the cursor before the page is read, so a stall in it resumes at this page.
    walk.cursor = after === null ? withoutResume(walk.cursor) : { ...walk.cursor, resume: { from, after } };
    const page = await api.changedPage(resource, from, after, customers);
    const rows = page.nodes.map((r) => readRow(r, resource, parse));
    for (const r of rows) {
      const { cursor } = walk;
      const id = String(r.id);
      if (r.at !== null && r.at > until) {
        // Too young to trust the index around it: the rest of the list is younger still.
        walk.cursor = withoutResume(walk.cursor);
        walk.caughtUp = true;
        failures.walked(resource);
        return;
      }
      if (r.at !== null && cursor.at !== null && (r.at < cursor.at || (r.at === cursor.at && cursor.landedAt.includes(id)))) continue;
      let landed = false;
      try {
        if (r.row === null) throw r.error;
        landed = await land(r.row);
        failures.landed(resource, r.id);
      } catch (err) {
        const verdict = verdictOf(err);
        if (verdict === 'pass') throw err;
        const outcome = failures.fail(resource, r.id, r.at, err, verdict, operation);
        if (outcome !== 'skip') throw outcome;
      }
      if (r.at === null) continue;
      const { at } = r;
      walk.cursor = { ...walk.cursor, ...(walk.cursor.at === at ? { landedAt: [...walk.cursor.landedAt, id] } : { at, landedAt: [id] }) };
      if (landed) walk.landed += 1;
    }
    if (!page.hasNextPage || page.endCursor === null) {
      walk.cursor = withoutResume(walk.cursor);
      walk.caughtUp = true;
      failures.walked(resource);
      return;
    }
    after = page.endCursor;
  }
  // The page budget ran out: the next pass reads on from the page after the last one landed.
  walk.cursor = { ...walk.cursor, resume: { from, after: after! } };
  failures.walked(resource);
}

function withoutResume(cursor: ShopifyCursor): ShopifyCursor {
  const { resume: _, ...rest } = cursor;
  return rest;
}

/** Reconcile one resource's delivered ids against the shop: every one `nodes` answers `null` for is reported deleted. */
async function reconcile(api: ShopifyApi, seen: SeenIds, land: (id: number) => Promise<void>): Promise<number> {
  await seen.loadAll();
  const tracked = seen.all();
  let removed = 0;
  for (let i = 0; i < tracked.length; i += SHOPIFY_NODES_PAGE) {
    const chunk = tracked.slice(i, i + SHOPIFY_NODES_PAGE);
    const present = await api.presentIds(seen.resource, chunk);
    for (const id of chunk) {
      if (present.has(id)) continue;
      await land(id);
      await seen.forget(id);
      removed += 1;
    }
  }
  return removed;
}

/** The scopes the app holds, as the shop reports them. Refuses a shop that lacks a required one. */
function scopesOf(info: ShopifyShopInfo): Set<string> {
  const held = new Set(info.currentAppInstallation.accessScopes.map((s) => s.handle));
  const missing = SHOPIFY_REQUIRED_SCOPES.filter((s) => !held.has(s));
  if (missing.length > 0) {
    throw new ShopifyApiError(`the app lacks ${missing.join(' and ')}: give it in the Dev Dashboard (Versions → Access scopes), release, and update the installation`, 403, 'ACCESS_DENIED');
  }
  return held;
}

function shopCurrency(value: string): CurrencyCode {
  const parsed = currencyCode.safeParse(value.toUpperCase());
  if (!parsed.success) throw new ShopifyApiError(`the shop's currency '${value}' is not an ISO 4217 code`, 502);
  return parsed.data;
}

/**
 * Sync ONE bound scope: read what changed at the shop since the cursor, land each product and
 * order through the binding's operation as the connection itself, and move the cursor.
 */
export async function syncShopifyScope(
  host: ScopeHost,
  connectionId: ConnectionId,
  binding: ShopifyBinding,
  options: ShopifyConnectorOptions,
): Promise<ShopifySyncResult> {
  if (binding.ownerScopeId && binding.ownerScopeId !== binding.scopeId) {
    throw new Error(`connection ${connectionId} is scope ${binding.ownerScopeId}'s own, and is bound to ${binding.scopeId}; nothing was read`);
  }
  const conn = await openShopifyConnection(host.admin, options.fetch, binding.tenantId, binding.vertical, options.timeoutMs ?? 30_000, {
    account: binding.externalAccountRef,
    owner: binding.ownerScopeId,
    expected: connectionId,
  });
  const now = (): number => options.now?.() ?? Date.now();
  const api = new ShopifyApi(conn, { sleep: options.sleep, now });
  const pages = options.pagesPerSync ?? SHOPIFY_PAGES_PER_SYNC;
  const until = new Date(now() - (options.settleMs ?? SHOPIFY_SETTLE_MS)).toISOString();

  // Read once per sync: a product states no currency, and what the app may read decides the queries.
  const info = await api.shopInfo();
  const currency = shopCurrency(info.shop.currencyCode);
  const scopes = scopesOf(info);
  const customers = scopes.has('read_customers');
  const allOrders = scopes.has('read_all_orders');
  const scope = landingScope(await host.getConnectorScope(connectionId, scopeIdSchema.parse(binding.scopeId)));

  const start: ShopifyCursor = { at: null, landedAt: [] };
  const products: Walk = { cursor: binding.lastSync?.products ?? start, landed: 0, caughtUp: false };
  const orders: Walk = { cursor: binding.lastSync?.orders ?? start, landed: 0, caughtUp: false };
  const seenProducts = new SeenIds(host.admin, connectionId, binding.scopeId, 'products');
  const seenOrders = new SeenIds(host.admin, connectionId, binding.scopeId, 'orders');
  const lastReconciled = binding.lastSync?.reconciledAt;
  const reconcileDue = lastReconciled === undefined || now() - Date.parse(lastReconciled) >= (options.reconcileEveryMs ?? SHOPIFY_RECONCILE_EVERY_MS);
  let reconciledAt = lastReconciled;
  let removed = 0;
  const failures = new RowFailures(binding.lastSync, () => new Date(now()).toISOString());
  const save = async (): Promise<void> => {
    // The ids first: a pass that dies between the two writes lands its rows again, which is safe.
    await seenProducts.flush();
    await seenOrders.flush();
    const caughtUp = products.caughtUp && orders.caughtUp;
    const same = (a: ShopifyCursor | undefined, b: ShopifyCursor): boolean => JSON.stringify(a) === JSON.stringify(b);
    const moved =
      !same(binding.lastSync?.products, products.cursor) ||
      !same(binding.lastSync?.orders, orders.cursor) ||
      reconciledAt !== lastReconciled ||
      binding.lastSync?.ordersReconciled !== allOrders ||
      removed > 0 ||
      failures.changed;
    // An idle pass writes nothing: most passes find a shop nobody has touched.
    if (!moved && binding.lastSync?.caughtUp === caughtUp) return;
    const synced: ShopifyBinding = {
      ...binding,
      lastSync: {
        syncedAt: new Date(now()).toISOString(),
        products: products.cursor,
        orders: orders.cursor,
        caughtUp,
        landed: { products: products.landed, orders: orders.landed, removed },
        ...(reconciledAt === undefined ? {} : { reconciledAt }),
        ordersReconciled: allOrders,
        ...(failures.stalledRows.length === 0 ? {} : { stalled: failures.stalledRows }),
        ...(failures.skipped.length === 0 ? {} : { skipped: failures.skipped }),
      },
    };
    await host.admin.putConnectorState(connectionId, bindingKey(binding.scopeId), synced);
  };

  const landProduct = async (row: ShopifyProduct): Promise<boolean> => {
    const more = row.variants.pageInfo.hasNextPage && row.variants.pageInfo.endCursor !== null ? await api.moreVariants(row.id, row.variants.pageInfo.endCursor) : [];
    const change = productChange(connectionId, currency, row, [...row.variants.nodes, ...more]);
    await scope.invoke(binding.operation, change);
    await seenProducts.live(Number(change.productId));
    return true;
  };
  const landOrder = async (row: ShopifyOrder): Promise<boolean> => {
    const more = row.lineItems.pageInfo.hasNextPage && row.lineItems.pageInfo.endCursor !== null ? await api.moreLineItems(row.id, row.lineItems.pageInfo.endCursor) : [];
    const change = orderChange(connectionId, row, [...row.lineItems.nodes, ...more]);
    await scope.invoke(binding.operation, change);
    await seenOrders.live(Number(change.orderId));
    return true;
  };
  const parseProduct = (r: unknown): ShopifyProduct => shopifyProduct.parse(r);
  const parseOrder = (r: unknown): ShopifyOrder => shopifyOrder.parse(r);

  /** Try each skipped record again by id: landed, it leaves the list; gone, nothing is left to land. */
  async function retrySkipped<T extends { id: string; updatedAt: string }>(resource: ShopifyResource, parse: (r: unknown) => T, land: (r: T) => Promise<boolean>, walk: Walk): Promise<void> {
    for (const skipped of failures.retryable(resource)) {
      let modifiedAt = skipped.modifiedAt;
      try {
        const raw = await api.record(resource, skipped.id, customers);
        if (raw === null) {
          failures.forget(resource, skipped.id);
          continue;
        }
        const r = readRow(raw, resource, parse);
        modifiedAt = r.at;
        if (r.row === null) throw r.error;
        if (await land(r.row)) walk.landed += 1;
        failures.landed(resource, skipped.id);
      } catch (err) {
        if (verdictOf(err) === 'pass') throw err;
        failures.retryFailed(skipped, modifiedAt, err, binding.operation);
      }
    }
  }

  let failure: unknown;
  let ended = false;
  const step = async (run: () => Promise<void>): Promise<void> => {
    if (ended) return;
    try {
      await run();
    } catch (err) {
      if (err instanceof ShopifyRowStall) failure ??= err;
      else {
        failure = err;
        ended = true;
      }
    }
  };
  await step(() => walkChanged(api, 'products', parseProduct, landProduct, failures, binding.operation, products, pages, until, customers));
  await step(() => walkChanged(api, 'orders', parseOrder, landOrder, failures, binding.operation, orders, pages, until, customers));
  if (reconcileDue) {
    await step(async () => {
      const startedAt = new Date(now()).toISOString();
      const report = (resource: ShopifyResource) => async (id: number) => {
        const key = resource === 'products' ? { record: 'product', productId: String(id) } : { record: 'order', orderId: String(id) };
        await scope.invoke(binding.operation, commerceChange.parse({ ...key, change: 'removed', connectionId, removal: 'deleted', observedAt: new Date(now()).toISOString() }));
      };
      removed += await reconcile(api, seenProducts, report('products'));
      // Without read_all_orders an old order is invisible, which no answer tells from a delete.
      if (allOrders) removed += await reconcile(api, seenOrders, report('orders'));
      reconciledAt = startedAt;
    });
    await step(async () => {
      await retrySkipped('products', parseProduct, landProduct, products);
      await retrySkipped('orders', parseOrder, landOrder, orders);
    });
  }
  await save();
  if (failure !== undefined) throw failure;
  return {
    scopeId: binding.scopeId,
    changed: products.landed + orders.landed + removed > 0,
    products: products.landed,
    orders: orders.landed,
    removed,
    caughtUp: products.caughtUp && orders.caughtUp,
    skipped: failures.skipped.length,
  };
}

/** A landing call the app's own operation refused (#3235): `said` is what the binding's tenant may read. */
export class ShopifyLandingRefusal extends Error {
  constructor(
    readonly said: string,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'ShopifyLandingRefusal';
  }
}

function landingScope(scope: ScopeStub): ScopeStub {
  return {
    tenantId: scope.tenantId,
    scopeId: scope.scopeId,
    ...(scope.subjectKind ? { subjectKind: scope.subjectKind } : {}),
    invoke: async <O, I>(operation: string, input?: I, options?: InvokeOptions): Promise<O> => {
      try {
        return await scope.invoke<O, I>(operation, input, options);
      } catch (err) {
        const said = landingRefusalSaid(operation, err);
        throw said === undefined ? err : new ShopifyLandingRefusal(said, err);
      }
    },
  };
}

export interface ShopifySweepResult {
  found: number;
  synced: ShopifySyncResult[];
  unchanged: number;
  /** `error` is staff's; `said`, when present, is what the binding's tenant may read about it. */
  failed: { scopeId: string; error: string; said?: string }[];
}

/** Poll the shop for every scope this connection is bound to — the sweeper a deployment schedules. */
export async function sweepShopify(host: ScopeHost, connectionId: ConnectionId, options: ShopifyConnectorOptions): Promise<ShopifySweepResult> {
  const rows = await host.admin.listConnectorState(connectionId, BINDING_PREFIX);
  const result: ShopifySweepResult = { found: 0, synced: [], unchanged: 0, failed: [] };
  for (const { value } of rows) {
    if (value === null || typeof value !== 'object') continue;
    const binding = value as ShopifyBinding;
    result.found += 1;
    try {
      const r = await syncShopifyScope(host, connectionId, binding, options);
      if (r.changed) result.synced.push(r);
      else result.unchanged += 1;
    } catch (err) {
      result.failed.push({
        scopeId: binding.scopeId,
        error: err instanceof Error ? err.message : String(err),
        ...(err instanceof ShopifyRowStall ? { said: err.said() } : err instanceof ShopifyLandingRefusal ? { said: err.said } : {}),
      });
    }
  }
  return result;
}

/**
 * Probe a credential that is not stored yet — the connect-time check. One mint and one query, so
 * each failure says something different: no shop at that name, a client the shop refuses, an app
 * without the scopes a sync needs. The answer names the shop and says how far back its orders reach.
 */
export async function probeShopifySecret(secret: Record<string, string>, options: ShopifyConnectorOptions): Promise<ConnectionProbe> {
  const parsed = shopifySecret.safeParse(secret);
  if (!parsed.success) return failed(true, `incomplete Shopify credential: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  try {
    shopDomain(parsed.data.shop);
  } catch (err) {
    return failed(false, err instanceof ShopDomainError ? err.message : String(err));
  }
  return probeWith(candidateConnection(parsed.data, options), options);
}

function candidateConnection(secret: ShopifySecret, options: ShopifyConnectorOptions): ConnectorConnection {
  return {
    id: connectionIdSchema.parse('00000000000000000000000000'), // no row yet; never read
    tenantId: '',
    vertical: '',
    provider: 'shopify',
    secret,
    // The client secret does not expire; it is rotated in the Dev Dashboard.
    expiresAt: null,
    fetch: deadlineFetch(options.fetch, options.timeoutMs ?? 15_000),
  };
}

/** Probe the credential a live connection already holds. Verifying is itself a use. */
export async function probeShopifyConnection(host: ScopeHost, connection: ShopifyConnectionRef, options: ShopifyConnectorOptions): Promise<ConnectionProbe> {
  const conn = await openShopifyConnection(host.admin, options.fetch, connection.tenantId, connection.vertical, options.timeoutMs ?? 15_000, {
    account: connection.externalAccountRef,
    owner: connection.ownerScopeId,
    expected: connection.id,
  });
  return probeWith(conn, options);
}

const failed = (refused: boolean, error: string): ConnectionProbe => ({ ok: false, refused, accountRef: null, accountLabel: null, facts: [], error: error.slice(0, 600) });

const clip = (s: string, n = 200): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

async function probeWith(conn: ConnectorConnection, options: ShopifyConnectorOptions): Promise<ConnectionProbe> {
  // A probe answers a person waiting on a form: a throttle is "busy, try again", not a wait.
  const api = new ShopifyApi(conn, { sleep: options.sleep, maxRateLimitRetries: 0, ...(options.now ? { now: options.now } : {}) });
  try {
    const info = await api.shopInfo();
    const scopes = scopesOf(info);
    return {
      ok: true,
      refused: false,
      // The shop, which the platform makes the connection's `externalAccountRef`: a credential for the
      // same shop rotates its connection, one for another shop is a connection of its own.
      accountRef: info.shop.myshopifyDomain,
      accountLabel: clip(info.shop.name || info.shop.myshopifyDomain),
      facts: [
        { label: 'Shop', value: clip(info.shop.name || '—') },
        { label: 'Shopify address', value: clip(info.shop.myshopifyDomain) },
        { label: 'Currency', value: clip(info.shop.currencyCode) },
        { label: 'Order history', value: scopes.has('read_all_orders') ? 'every order' : 'the last 60 days only — Shopify grants read_all_orders on request' },
        { label: 'Customer accounts', value: scopes.has('read_customers') ? 'named on each order' : 'not read (no read_customers scope)' },
      ],
      error: null,
    };
  } catch (err) {
    const refused = err instanceof ShopifyApiError && err.refused;
    const notShop = err instanceof ShopifyApiError && err.notStore;
    const message = err instanceof Error ? err.message : String(err);
    if (notShop) return failed(false, `no Shopify shop at ${safeShop(api)}: ${message}`);
    return failed(
      refused,
      refused && err instanceof ShopifyApiError && err.code !== 'ACCESS_DENIED'
        ? `${message} — use the client ID and secret from the app's Settings in the Dev Dashboard, and install the app on this shop first`
        : message,
    );
  }
}

function safeShop(api: ShopifyApi): string {
  try {
    return api.shop();
  } catch {
    return 'that address';
  }
}

const recordName = (f: ShopifyRowFailure): string => `${f.resource === 'products' ? 'product' : 'order'} ${f.id}`;
const ACTIVITY_SKIPPED_NAMED = 10;

function bindingStatus(s: ShopifyBinding['lastSync']): string {
  if (!s) return 'bound — not yet synced';
  const stalled = s.stalled ?? [];
  if (stalled.length > 0) return `stalled at ${stalled.map(recordName).join(' and ')}`;
  const skipped = s.skipped?.length ?? 0;
  const base = s.caughtUp ? 'synced' : 'catching up';
  return skipped === 0 ? base : `${base} — ${skipped} skipped`;
}

/** What this connection has been doing, for a console — one entry per bound scope, from the ledger. */
export async function shopifyConnectionActivity(host: ScopeHost, connectionId: ConnectionId): Promise<ConnectionActivity> {
  const rows = await host.admin.listConnectorState(connectionId, BINDING_PREFIX);
  const entries = rows
    .filter(({ value }) => value !== null && typeof value === 'object')
    .map(({ key, value }) => {
      const b = value as ShopifyBinding;
      const s = b.lastSync;
      const skipped = s?.skipped ?? [];
      return {
        key,
        title: `${b.vertical} — ${b.scopeId}`,
        reference: null,
        status: bindingStatus(s),
        at: instant.parse(s?.syncedAt ?? b.boundAt),
        facts: [
          { label: 'Lands through', value: b.operation },
          { label: 'Permission', value: b.permission },
          ...(s
            ? [
                { label: 'Products changed up to', value: s.products.at ?? '—' },
                { label: 'Orders changed up to', value: s.orders.at ?? '—' },
                { label: 'Last pass landed', value: `${s.landed.products} products, ${s.landed.orders} orders, ${s.landed.removed} removals` },
                { label: 'Deletes reconciled', value: `${s.reconciledAt ?? '—'}${s.ordersReconciled === false ? ' (products only: no read_all_orders)' : ''}` },
                ...(s.stalled ?? []).map((f) => ({ label: `Waiting at ${recordName(f)}`, value: `${f.error} — failed ${f.attempts} of ${SHOPIFY_ROW_ATTEMPTS} passes since ${f.firstFailedAt}` })),
                ...skipped.slice(0, ACTIVITY_SKIPPED_NAMED).map((f) => ({ label: `Skipped ${recordName(f)}`, value: `${f.error} — last tried ${f.failedAt}` })),
                ...(skipped.length > ACTIVITY_SKIPPED_NAMED ? [{ label: 'Skipped, not named', value: `${skipped.length - ACTIVITY_SKIPPED_NAMED} more` }] : []),
              ]
            : []),
        ].map((f) => ({ label: f.label.slice(0, 80), value: f.value.slice(0, 400) })),
      };
    });
  return connectionActivity.parse({ source: 'ledger', entries, live: false });
}

/**
 * The platform's preparation of a candidate credential, run before it is stored. It asks the shop
 * for its own `myshopify.com` name and stores that as `shop`, so what a person typed (`acme`,
 * `https://acme.myshopify.com/admin`) is kept in one canonical form. On a replacement it refuses,
 * before anything is stored, a credential for another shop: nothing the connection keeps is true of
 * it. A shop that does not answer is a 503, nothing stored.
 */
export function prepareShopifyCandidate(
  options: ShopifyConnectorOptions,
): (candidate: Record<string, string>, previous: Record<string, string> | undefined) => Promise<{ secret: Record<string, string> }> {
  return async (candidate, previous) => {
    const parsed = shopifySecret.safeParse(candidate);
    if (!parsed.success) throw new ShopifyKeyRefusal(`incomplete Shopify credential: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`, 422);
    const api = new ShopifyApi(candidateConnection(parsed.data, options), { sleep: options.sleep, maxRateLimitRetries: 0 });
    let shop: string;
    try {
      shop = shopDomain((await api.shopInfo()).shop.myshopifyDomain);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof ShopDomainError || (err instanceof ShopifyApiError && (err.refused || err.notStore))) throw new ShopifyKeyRefusal(message, 422);
      throw new ShopifyKeyRefusal(`the shop did not say which shop it is, so nothing was stored; try again in a moment (${clip(message)})`, 503);
    }
    if (previous !== undefined && typeof previous.shop === 'string') {
      let before: string | null;
      try {
        before = shopDomain(previous.shop);
      } catch {
        before = null;
      }
      if (before !== shop) {
        throw new ShopifyKeyRefusal(`this app reads the shop ${shop}, and this connection is for ${before ?? 'another shop'}; a connection stays on one shop, so disconnect it, then connect again`, 422);
      }
    }
    return { secret: { shop, clientId: parsed.data.clientId, clientSecret: parsed.data.clientSecret } };
  };
}

/** A credential {@link prepareShopifyCandidate} will not store, with the status the relay answers. */
export class ShopifyKeyRefusal extends Error {
  readonly status: 422 | 503;
  constructor(message: string, status: 422 | 503) {
    super(message);
    this.name = 'ShopifyKeyRefusal';
    this.status = status;
  }
}

/** The stored credential, reduced: the shop and client ID in full, the secret masked. */
export async function shopifyCredentialSummary(host: ScopeHost, connection: ShopifyConnectionRef): Promise<ConnectionCredential> {
  const open = await openShopifyCredential(host.admin, connection.tenantId, connection.vertical, {
    account: connection.externalAccountRef,
    owner: connection.ownerScopeId,
    expected: connection.id,
  });
  const secret = shopifySecret.parse(open.secret);
  return {
    fields: [
      { key: 'shop', label: 'Shop', value: clip(secret.shop), masked: false },
      { key: 'clientId', label: 'Client ID', value: clip(secret.clientId), masked: false },
      { key: 'clientSecret', label: 'Client secret', value: maskSecret(secret.clientSecret), masked: true },
    ],
  };
}

const maskSecret = (value: string): string => (value.length < 8 ? '••••••••' : `••••••••${value.slice(-4)}`);

/** A Shopify connection as a caller knows it. */
export interface ShopifyConnectionRef {
  id?: ConnectionId;
  tenantId: string;
  vertical: string;
  externalAccountRef?: string | null;
  ownerScopeId?: string | null;
}

type Select = { account?: string | null; owner?: string | null; expected?: ConnectionId };

/** Open one Shopify connection's credential, by shop and owner, refusing any but the one expected (as WooCommerce's). */
async function openShopifyCredential(admin: HostAdmin, tenant: string, vertical: string, select: Select): Promise<OpenConnection> {
  const t = tenantIdSchema.parse(tenant);
  const owner = select.owner ? scopeIdSchema.parse(select.owner) : undefined;
  const open =
    (select.account ? await admin.openConnection(t, vertical, 'shopify', select.account, owner) : undefined) ??
    (await admin.openConnection(t, vertical, 'shopify', undefined, owner));
  if (!open) throw new Error(`no live 'shopify' connection for tenant ${tenant} / vertical '${vertical}'`);
  if (select.expected !== undefined && open.id !== select.expected) {
    throw new Error(
      `binding names connection ${select.expected}, but the live 'shopify' connection for tenant ${tenant} / ` +
        `vertical '${vertical}' is ${open.id}. Re-bind the scope against ${open.id}.`,
    );
  }
  return open;
}

/** {@link openShopifyCredential}, with health recorded on every call it makes. */
async function openShopifyConnection(admin: HostAdmin, fetchImpl: FetchLike, tenant: string, vertical: string, timeoutMs: number, select: Select = {}): Promise<ConnectorConnection> {
  const open = await openShopifyCredential(admin, tenant, vertical, select);
  const bounded = deadlineFetch(fetchImpl, timeoutMs);
  return {
    ...open,
    fetch: async (input, init) => {
      const started = Date.now();
      try {
        const res = await bounded(input, init);
        await admin.recordConnectionUse(open.id, settleConnectionUse('shopify', Date.now() - started, { response: res }));
        return res;
      } catch (err) {
        await admin.recordConnectionUse(open.id, settleConnectionUse('shopify', Date.now() - started, { error: err }));
        throw err;
      }
    },
  };
}
