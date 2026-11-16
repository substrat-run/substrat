import {
  commerceChange,
  connectionActivity,
  connectionId as connectionIdSchema,
  currencyCode,
  instant,
  scopeId as scopeIdSchema,
  tenantId as tenantIdSchema,
  type ConnectionActivity,
  type ConnectionCredential,
  type ConnectionProbe,
  type ConnectionId,
  type CurrencyCode,
  type Instant,
  type OpenConnection,
} from '@substrat-run/contracts';
import type { ConnectorConnection, FetchLike, HostAdmin, InvokeOptions, ScopeHost, ScopeStub } from '@substrat-run/kernel';
import { deadlineFetch, landingRefusalSaid, settleConnectionUse } from '@substrat-run/kernel';
import {
  WooCommerceApi,
  WooCommerceApiError,
  WOOCOMMERCE_MAX_PAGE,
  wcOrder,
  wcProduct,
  woocommerceSecret,
  type WcStoreInfo,
  type WooCommerceSecret,
} from './api.js';
import { modifiedAtOf, orderChange, productChange } from './commerce.js';
import { storeBaseUrl, StoreUrlError, woocommerceStoreRef } from './store-url.js';
import { SeenIds, type SeenResource } from './seen.js';

export {
  WooCommerceApi,
  WooCommerceApiError,
  WOOCOMMERCE_API_PATH,
  WOOCOMMERCE_MAX_PAGE,
  woocommerceSecret,
  type WooCommerceApiOptions,
  type WooCommerceSecret,
  type WcOrder,
  type WcProduct,
  type WcVariation,
} from './api.js';
export { gmtInstant, orderChange, productChange, WooCommerceMappingError } from './commerce.js';
export { storeBaseUrl, StoreUrlError, woocommerceStoreRef } from './store-url.js';
export { SEEN_BUCKET_WIDTH } from './seen.js';
export { WooCommerceMock, type WooCommerceMockOptions } from './mock.js';

/**
 * The WooCommerce connector — a store's products and orders, landed in a scope in the
 * provider-neutral commerce shape (`commerceChange` in `@substrat-run/contracts`, #3136).
 *
 * The vertical codes against that shape, not against WooCommerce: the landing operation, its tables
 * and the schema it parses stay the same when a second store platform's connector lands the same
 * records. What stays WooCommerce's is the connection — the store URL, the key, the probe.
 *
 * ## Poll-only, read-only
 *
 * Nothing inside a scope asks for an order; orders happen at the store and the platform finds out
 * by looking. So this connector registers no dispatch, and {@link sweepWooCommerce} is its whole
 * trigger surface. Every call is a `GET`, so the key it is given needs Read permission and nothing
 * more — which is also all a leaked key would then be worth.
 *
 * ## The sync is a keyset walk over "changed since"
 *
 * Products and orders are each read oldest change first (`orderby=modified&order=asc`) from a
 * per-resource cursor: the last change landed, to the second, and the ids landed AT that second.
 * Every request restarts from the cursor rather than asking for page N, because a page-number walk
 * over a list sorted by modification loses rows: an item edited mid-walk moves to the end and shifts
 * an unseen one back across the page boundary, and the cursor then passes it for good. The request
 * asks from one second before the cursor and skips what it already landed, so the walk is correct
 * whether WooCommerce's `modified_after` turns out to include its boundary or not.
 *
 * A pass lands at most {@link WOOCOMMERCE_PAGES_PER_SYNC} pages per resource, so a store's first
 * sweep (every product and order it ever had) is spread over several passes rather than holding one.
 *
 * ## What it does NOT see, and says so
 *
 * - **A variation changed without its product.** WooCommerce bumps a variation's own modified date,
 *   not its parent's, and the sync reads a variable product's variations only when the product
 *   itself is in the changed list. A price edited on one variant reaches the scope the next time
 *   the product is saved. Listing every variable product's variations on every pass is the fix, and
 *   its cost is why it is not this slice.
 * - **Draft checkouts** (`checkout-draft`): a cart the block checkout saved, not an order. Skipped.
 *
 * ## Stock rides on the product (#3223)
 *
 * Each variant carries its stock — counted or not, how many, in stock / out / on backorder — read
 * from the same product and variation rows the walk already reads, so it costs no request. It is
 * fresh because a stock change saves its product: a sale's `wc_update_product_stock` saves the
 * product (or the variation, which then syncs its product), and a save moves the product's modified
 * date even when only stock changed. `test/live.test.ts` checks that on a real store; it is the
 * whole reason stock needs no cursor of its own.
 *
 * ## Deletes: a reconcile pass over what was delivered (#3224)
 *
 * A deleted record is in no "changed since" list, and a trashed one is left out of every listing
 * by default, so the walk cannot see either. The connector remembers every id it delivered to a
 * scope ({@link SeenIds}, in connector state) and, once per {@link WOOCOMMERCE_RECONCILE_EVERY_MS},
 * asks the store about exactly those ids:
 *
 * 1. which are still there — `include=<100 ids>&status=any&_fields=id`, one request per hundred
 *    delivered ids;
 * 2. of those missing, which are in the trash — the same with `status=trash`, one request per
 *    hundred missing (none when nothing is missing);
 * 3. each still unaccounted for is read on its own, and only WooCommerce's "invalid id" 404 makes
 *    it `deleted`. Deletes are rare, so this is the one per-id cost, and it is what keeps a store
 *    that ignores `include` (a plugin) or answers a 404 from no route from reading as "everything
 *    was deleted". At most {@link WOOCOMMERCE_MAX_PAGE} are read per resource per pass; the next
 *    pass reconciles again and reads on from the last id read (`lastSync.confirmAfter`), wrapping
 *    round, so every one is reached however many a store leaves unaccounted.
 *
 * Each removal lands through the binding's operation as a `commerceChange` with `change:
 * 'removed'`, before its id is marked reported, so a failure re-reports it (at least once). An id
 * that was never delivered is never asked about, so never reported. A trashed id stays watched
 * and is reported again as `deleted` when the trash is emptied; one restored from the trash arrives
 * as an upsert, since restoring saves it.
 *
 * A binding synced before this tracking existed has cursors but no delivered ids. Its walk starts
 * over once (`lastSync.tracksDelivered` absent), re-landing the store as upserts — which delivery
 * already allows — and recording each id as it lands, with progress kept by the ordinary cursor.
 *
 * Webhooks (`product.deleted`, `order.deleted`) would only shorten the wait, never replace this
 * pass, and need an inbound route per store; they are a later slice.
 *
 * ## Where the data lands, and why the connector does not decide
 *
 * As for Planima: {@link bindWooCommerceScope} names the scope, the operation the records land
 * through and the permission that operation checks, and refuses a binding whose connection does not
 * hold it. What an order MEANS to a business is the vertical's vocabulary.
 *
 * ## A connection is one store (#3219)
 *
 * The platform keys a WooCommerce connection on the store its connect-time probe names
 * ({@link woocommerceStoreRef} of the store's own `home_url`), not on the app: a key for the same
 * store rotates that store's connection and keeps its cursors, and a key for another store becomes a
 * connection of its own. Everything a connection keeps — each binding's cursor — is only true of its
 * store, so every open names the store ({@link WooCommerceBinding.externalAccountRef}), and the key
 * is pinned to it before it is stored ({@link prepareWooCommerceCandidate}). A store that moves
 * domain is a new connection; connect the new address, then disconnect the old one.
 *
 * ## A scope may own its shop's connection (#3201)
 *
 * A vertical whose scopes are each one store, each with its own shop, connects each shop as that
 * scope's OWN connection (`owner: 'scope'`, bound through an `on-request` landing, #2732), so a
 * scope is delivered its own shop's products and orders and never a sibling's — orders carry
 * customers' names, emails and addresses. The connector opens a scope's own connection wherever it
 * opens one: the binding records the owner ({@link WooCommerceBinding.ownerScopeId}), every open
 * names it, and a scope's own connection lands in that scope alone.
 */

/**
 * The standing grants this connector requires — deliberately empty, for Planima's reason: the
 * permission is whatever the consumer's landing operation checks, so it is verified at bind time.
 */
export const WOOCOMMERCE_CONNECTION_GRANTS = [] as const;

/** How often a binding's delivered ids are reconciled against the store — every fourth 15-minute pass. */
export const WOOCOMMERCE_RECONCILE_EVERY_MS = 60 * 60 * 1000;

/** How many pages (of {@link WOOCOMMERCE_MAX_PAGE}) of each resource one sync lands at most. */
export const WOOCOMMERCE_PAGES_PER_SYNC = 10;

const BINDING_PREFIX = 'woocommerce:binding:';
const bindingKey = (scope: string): string => `${BINDING_PREFIX}${scope}`;

/** Where a resource's walk stands: the last change landed, and the ids landed at that second. */
export interface WooCommerceCursor {
  at: string | null;
  landedAt: string[];
}

export interface WooCommerceBinding {
  scopeId: string;
  tenantId: string;
  vertical: string;
  /** The operation each `commerceChange` lands through — the vertical's, named by whoever binds. */
  operation: string;
  /** The permission `operation` checks, which the connection must hold on `scopeId`. */
  permission: string;
  /**
   * WHICH store's connection this is (#3219): the connection's `externalAccountRef`, the store its
   * probe named ({@link woocommerceStoreRef}). A tenant may connect several stores to one app, each
   * its own connection, so the credential cannot be found from the tenant and vertical alone: the
   * sweep opens it by this. Absent on a binding of a connection made before connections were keyed
   * on their store, which is the app's only WooCommerce connection.
   */
  externalAccountRef?: string | null;
  /**
   * The scope that OWNS this connection (#3201), for a scope's own connection: always the bound
   * scope, and the sweep opens the credential by it. Absent for the tenant's connection.
   */
  ownerScopeId?: string | null;
  boundAt: string;
  lastSync?: {
    syncedAt: string;
    products: WooCommerceCursor;
    orders: WooCommerceCursor;
    /** False when a pass stopped at its page budget with changes still to read. */
    caughtUp: boolean;
    /** Removals reported by this pass's reconcile — absent on a binding synced before #3224. */
    landed: { products: number; orders: number; removed?: number };
    /** When the delivered ids were last reconciled in full; absent until the first time. */
    reconciledAt?: string;
    /**
     * Set once the cursors only cover rows whose ids were recorded as delivered (#3224). Absent on a
     * binding synced before that: its walk starts over once, so every delivered id is recorded.
     */
    tracksDelivered?: true;
    /** Where the capped one-by-one confirmation stopped, per resource; the next pass reads on from there. */
    confirmAfter?: { products?: number; orders?: number };
  };
}

export interface WooCommerceConnectorOptions {
  fetch: FetchLike;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Pages per resource per sync; {@link WOOCOMMERCE_PAGES_PER_SYNC} by default. */
  pagesPerSync?: number;
  /** How often delivered ids are reconciled; {@link WOOCOMMERCE_RECONCILE_EVERY_MS} by default. */
  reconcileEveryMs?: number;
  /** For the live test's local store only. Never set by the platform. */
  allowLocalHttp?: boolean;
}

/** Declare that a connection syncs one scope. Refuses a binding whose grant is missing. */
export async function bindWooCommerceScope(
  host: ScopeHost,
  input: {
    connectionId: ConnectionId;
    tenantId: string;
    scopeId: string;
    vertical: string;
    operation: string;
    permission: string;
    /** The connection's `externalAccountRef`. See {@link WooCommerceBinding.externalAccountRef}. */
    externalAccountRef?: string | null;
    /** The connection's owner, for a scope's own. See {@link WooCommerceBinding.ownerScopeId}. */
    ownerScopeId?: string | null;
    /** Internal automatic-pass path: the declaration was checked and its grant follows this write. */
    grantPreflighted?: boolean;
    now?: () => number;
  },
): Promise<WooCommerceBinding> {
  const tenant = tenantIdSchema.parse(input.tenantId);
  const scope = scopeIdSchema.parse(input.scopeId);
  if (input.ownerScopeId && input.ownerScopeId !== input.scopeId) {
    throw new Error(`connection ${input.connectionId} is scope ${input.ownerScopeId}'s own, and lands in that scope alone, not ${input.scopeId}`);
  }
  const granted = input.grantPreflighted ? [] : await host.connectionGrantsInScope(tenant, scope);
  const held =
    input.grantPreflighted ||
    granted.some(
      (g: { connectionId: string; permission: string }) =>
        g.connectionId === input.connectionId && g.permission === input.permission,
    );
  if (!held) {
    throw new Error(
      `connection ${input.connectionId} does not hold '${input.permission}' on scope ${input.scopeId} — ` +
        `a sweep would read the store and then fail to land it. Grant it first (grantToConnection), then bind.`,
    );
  }
  const binding: WooCommerceBinding = {
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
export async function listWooCommerceBindings(host: ScopeHost, connectionId: ConnectionId): Promise<WooCommerceBinding[]> {
  const rows = await host.admin.listConnectorState(connectionId, BINDING_PREFIX);
  return rows.filter((r) => r.value !== null && typeof r.value === 'object').map((r) => r.value as WooCommerceBinding);
}

/** Stop syncing one scope (a tombstone, as for every connector-state row). */
export async function unbindWooCommerceScope(host: ScopeHost, connectionId: ConnectionId, scopeId: string): Promise<void> {
  await host.admin.putConnectorState(connectionId, bindingKey(scopeId), null);
}

export interface WooCommerceSyncResult {
  scopeId: string;
  /** False when nothing had changed at the store since the last sync — nothing was landed. */
  changed: boolean;
  products: number;
  orders: number;
  /** Products and orders reported removed by this pass's reconcile. */
  removed: number;
  caughtUp: boolean;
}

/** `at` minus one second, in the form `modified_after` takes with `dates_are_gmt=true`. */
function secondBefore(at: string): string {
  return new Date(Date.parse(at) - 1000).toISOString().slice(0, 19);
}

interface Walk {
  cursor: WooCommerceCursor;
  landed: number;
  caughtUp: boolean;
}

/**
 * Walk one resource from its cursor, landing each fresh row through `land` in change order. The
 * cursor in `walk` is advanced after each landed row, so a failure leaves it on the last row that
 * did land — the caller saves it before rethrowing, and one row that cannot land blocks only itself.
 */
async function walkChanged<T extends { id: number }>(
  api: WooCommerceApi,
  resource: 'products' | 'orders',
  parse: (row: unknown) => T,
  modifiedAt: (row: T) => Instant,
  /** Answers false for a row it deliberately skips: the cursor passes it, the count does not. */
  land: (row: T) => Promise<boolean>,
  walk: Walk,
  pages: number,
): Promise<void> {
  // Asked from one second before the cursor, the list starts with the rows already landed at the
  // cursor's second (after, if `modified_after` is inclusive, the few of the second before). Whole
  // pages of them are skipped by number: otherwise more rows in one second than a page holds would
  // send every pass back to the same page of landed rows, and the walk would never move.
  const resume = (): number => 1 + Math.floor(walk.cursor.landedAt.length / WOOCOMMERCE_MAX_PAGE);
  let page = resume();
  for (let request = 0; request < pages; request += 1) {
    const from = walk.cursor.at;
    const raw = await api.changedPage(resource, from === null ? null : secondBefore(from), page);
    const rows = raw.map(parse).map((row) => ({ row, at: modifiedAt(row) }));
    rows.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.row.id - b.row.id));
    for (const { row, at } of rows) {
      const { cursor } = walk;
      const id = String(row.id);
      if (cursor.at !== null && (at < cursor.at || (at === cursor.at && cursor.landedAt.includes(id)))) continue;
      const landed = await land(row);
      walk.cursor = cursor.at === at ? { at, landedAt: [...cursor.landedAt, id] } : { at, landedAt: [id] };
      if (landed) walk.landed += 1;
    }
    if (raw.length < WOOCOMMERCE_MAX_PAGE) {
      walk.caughtUp = true;
      return;
    }
    // A full page that moved the cursor: ask again from the new cursor. One that did not (a page
    // wholly inside one second) can only move on by page number.
    page = walk.cursor.at === from ? page + 1 : resume();
  }
}

/**
 * Reconcile one resource's delivered ids against the store (see "Deletes" above). Each removal is
 * landed through `land` before `seen` records it. Answers how many it reported, and whether every
 * missing id was accounted for (false when the per-pass read budget stopped it).
 */
async function reconcile(
  api: WooCommerceApi,
  seen: SeenIds,
  /** The last id the previous pass confirmed on its own, when it stopped at the budget. */
  confirmAfter: number | undefined,
  land: (id: number, removal: 'trashed' | 'deleted') => Promise<void>,
): Promise<{ removed: number; complete: boolean; confirmAfter: number | undefined }> {
  const resource: SeenResource = seen.resource;
  await seen.loadAll();
  const tracked = seen.all();
  const chunks = <T>(xs: readonly T[]): T[][] =>
    Array.from({ length: Math.ceil(xs.length / WOOCOMMERCE_MAX_PAGE) }, (_, i) => xs.slice(i * WOOCOMMERCE_MAX_PAGE, (i + 1) * WOOCOMMERCE_MAX_PAGE));

  const present = new Set<number>();
  for (const chunk of chunks(tracked.map((t) => t.id))) for (const id of await api.presentIds(resource, chunk, 'any')) present.add(id);
  const missing = tracked.filter((t) => !present.has(t.id));
  const inTrash = new Set<number>();
  for (const chunk of chunks(missing.map((t) => t.id))) for (const id of await api.presentIds(resource, chunk, 'trash')) inTrash.add(id);

  let removed = 0;
  // Back from the trash: watched as live again. Restoring saves it, so the walk lands its upsert.
  for (const t of tracked) if (t.trashed && present.has(t.id)) await seen.live(t.id);
  const unaccounted: typeof missing = [];
  for (const t of missing) {
    if (!inTrash.has(t.id)) unaccounted.push(t);
    else if (!t.trashed) {
      await land(t.id, 'trashed');
      await seen.trashed(t.id);
      removed += 1;
    }
  }
  // Read on from where the last capped pass stopped, wrapping round: a store whose batch answer
  // always leaves the same ids out would otherwise spend every pass on the lowest of them.
  const from = confirmAfter === undefined ? 0 : unaccounted.findIndex((t) => t.id > confirmAfter);
  const rotated = from <= 0 ? unaccounted : [...unaccounted.slice(from), ...unaccounted.slice(0, from)];
  const batch = rotated.slice(0, WOOCOMMERCE_MAX_PAGE);
  for (const t of batch) {
    const status = await api.statusOf(resource, t.id);
    if (status === null) {
      await land(t.id, 'deleted');
      await seen.forget(t.id);
      removed += 1;
    } else if (status === 'trash' && !t.trashed) {
      await land(t.id, 'trashed');
      await seen.trashed(t.id);
      removed += 1;
    }
    // Any other status: still at the store, missed by the batch read. Nothing to report.
  }
  const complete = unaccounted.length <= WOOCOMMERCE_MAX_PAGE;
  return { removed, complete, confirmAfter: complete ? undefined : batch.at(-1)?.id };
}

/**
 * Sync ONE bound scope: read what changed at the store since the cursor, land each product and
 * order through the binding's operation as the connection itself, and move the cursor.
 */
export async function syncWooCommerceScope(
  host: ScopeHost,
  connectionId: ConnectionId,
  binding: WooCommerceBinding,
  options: WooCommerceConnectorOptions,
): Promise<WooCommerceSyncResult> {
  // A scope's own shop lands in that scope alone, whatever wrote the binding (#3201).
  if (binding.ownerScopeId && binding.ownerScopeId !== binding.scopeId) {
    throw new Error(`connection ${connectionId} is scope ${binding.ownerScopeId}'s own, and is bound to ${binding.scopeId}; nothing was read`);
  }
  const conn = await openWooCommerceConnection(
    host.admin,
    options.fetch,
    binding.tenantId,
    binding.vertical,
    options.timeoutMs ?? 30_000,
    { account: binding.externalAccountRef, owner: binding.ownerScopeId, expected: connectionId },
  );
  const api = new WooCommerceApi(conn, { sleep: options.sleep, allowLocalHttp: options.allowLocalHttp });
  const pages = options.pagesPerSync ?? WOOCOMMERCE_PAGES_PER_SYNC;

  // Read once per sync: a product states no currency, so its prices are in the store's.
  const currency = storeCurrency((await api.storeInfo()).settings.currency);
  // #3235: a refusal from the app's landing operation carries what the tenant may read about it.
  const scope = landingScope(await host.getConnectorScope(connectionId, scopeIdSchema.parse(binding.scopeId)));

  // A binding synced before delivered ids were recorded walks the store once more from the start.
  const tracked = binding.lastSync?.tracksDelivered === true;
  const start: WooCommerceCursor = { at: null, landedAt: [] };
  const products: Walk = { cursor: (tracked ? binding.lastSync?.products : undefined) ?? start, landed: 0, caughtUp: false };
  const orders: Walk = { cursor: (tracked ? binding.lastSync?.orders : undefined) ?? start, landed: 0, caughtUp: false };
  const lastConfirmAfter = binding.lastSync?.confirmAfter ?? {};
  let confirmAfter = lastConfirmAfter;
  const seenProducts = new SeenIds(host.admin, connectionId, binding.scopeId, 'products');
  const seenOrders = new SeenIds(host.admin, connectionId, binding.scopeId, 'orders');
  const now = (): number => options.now?.() ?? Date.now();
  const lastReconciled = binding.lastSync?.reconciledAt;
  const reconcileDue =
    lastReconciled === undefined || now() - Date.parse(lastReconciled) >= (options.reconcileEveryMs ?? WOOCOMMERCE_RECONCILE_EVERY_MS);
  let reconciledAt = lastReconciled;
  let removed = 0;
  const save = async (): Promise<void> => {
    // The ids first: a pass that dies between the two writes lands its rows again, which is safe;
    // the other order could leave a delivered id unrecorded, and its delete unreported.
    await seenProducts.flush();
    await seenOrders.flush();
    const caughtUp = products.caughtUp && orders.caughtUp;
    const moved =
      products.cursor !== binding.lastSync?.products ||
      orders.cursor !== binding.lastSync?.orders ||
      reconciledAt !== lastReconciled ||
      confirmAfter !== lastConfirmAfter ||
      !tracked ||
      removed > 0;
    // An idle pass writes nothing: most passes find a store nobody has touched.
    if (!moved && binding.lastSync?.caughtUp === caughtUp) return;
    const synced: WooCommerceBinding = {
      ...binding,
      lastSync: {
        syncedAt: new Date(now()).toISOString(),
        products: products.cursor,
        orders: orders.cursor,
        caughtUp,
        landed: { products: products.landed, orders: orders.landed, removed },
        ...(reconciledAt === undefined ? {} : { reconciledAt }),
        tracksDelivered: true,
        ...(Object.keys(confirmAfter).length === 0 ? {} : { confirmAfter }),
      },
    };
    await host.admin.putConnectorState(connectionId, bindingKey(binding.scopeId), synced);
  };

  try {
    await walkChanged(
      api,
      'products',
      (r) => wcProduct.parse(r),
      (r) => modifiedAtOf(r, 'product'),
      async (row) => {
        const variations = row.type === 'variable' ? await api.variations(row.id) : [];
        await scope.invoke(binding.operation, productChange(connectionId, currency, row, variations));
        await seenProducts.live(row.id);
        return true;
      },
      products,
      pages,
    );
    await walkChanged(
      api,
      'orders',
      (r) => wcOrder.parse(r),
      (r) => modifiedAtOf(r, 'order'),
      async (row) => {
        if (row.status === 'checkout-draft') return false;
        await scope.invoke(binding.operation, orderChange(connectionId, row));
        await seenOrders.live(row.id);
        return true;
      },
      orders,
      pages,
    );
    if (reconcileDue) {
      const startedAt = new Date(now()).toISOString();
      let complete = true;
      const next: { products?: number; orders?: number } = {};
      for (const seen of [seenProducts, seenOrders]) {
        const r = await reconcile(api, seen, lastConfirmAfter[seen.resource], async (id, removal) => {
          const key = seen.resource === 'products' ? { record: 'product', productId: String(id) } : { record: 'order', orderId: String(id) };
          await scope.invoke(
            binding.operation,
            commerceChange.parse({ ...key, change: 'removed', connectionId, removal, observedAt: new Date(now()).toISOString() }),
          );
        });
        removed += r.removed;
        complete &&= r.complete;
        if (r.confirmAfter !== undefined) next[seen.resource] = r.confirmAfter;
      }
      confirmAfter = next;
      // An incomplete pass leaves the clock where it was, so the next pass reconciles again.
      if (complete) reconciledAt = startedAt;
    }
  } catch (err) {
    // Keep what did land, so the next pass resumes after it instead of landing it all again.
    await save();
    throw err;
  }
  await save();
  return {
    scopeId: binding.scopeId,
    changed: products.landed + orders.landed + removed > 0,
    products: products.landed,
    orders: orders.landed,
    removed,
    caughtUp: products.caughtUp && orders.caughtUp,
  };
}

function storeCurrency(value: string): CurrencyCode {
  const parsed = currencyCode.safeParse(value.toUpperCase());
  if (!parsed.success) throw new WooCommerceApiError(`the store's currency '${value}' is not an ISO 4217 code`, 502);
  return parsed.data;
}

/**
 * #3235: a landing call the app's own operation refused. `message` is the refusal as thrown, which
 * stays staff's; `said` is what the binding's tenant may read about it (`landingRefusalSaid`).
 */
export class WooCommerceLandingRefusal extends Error {
  constructor(
    readonly said: string,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'WooCommerceLandingRefusal';
  }
}

/** The scope stub, its `invoke` rethrowing an app's own refusal as a {@link WooCommerceLandingRefusal}. */
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
        throw said === undefined ? err : new WooCommerceLandingRefusal(said, err);
      }
    },
  };
}

export interface WooCommerceSweepResult {
  found: number;
  synced: WooCommerceSyncResult[];
  unchanged: number;
  /** `error` is staff's; `said`, when present, is what the binding's tenant may read about it (#3235). */
  failed: { scopeId: string; error: string; said?: string }[];
}

/** Poll the store for every scope this connection is bound to — the sweeper a deployment schedules. */
export async function sweepWooCommerce(
  host: ScopeHost,
  connectionId: ConnectionId,
  options: WooCommerceConnectorOptions,
): Promise<WooCommerceSweepResult> {
  const rows = await host.admin.listConnectorState(connectionId, BINDING_PREFIX);
  const result: WooCommerceSweepResult = { found: 0, synced: [], unchanged: 0, failed: [] };
  for (const { value } of rows) {
    if (value === null || typeof value !== 'object') continue;
    const binding = value as WooCommerceBinding;
    result.found += 1;
    try {
      const r = await syncWooCommerceScope(host, connectionId, binding, options);
      if (r.changed) result.synced.push(r);
      else result.unchanged += 1;
    } catch (err) {
      result.failed.push({
        scopeId: binding.scopeId,
        error: err instanceof Error ? err.message : String(err),
        ...(err instanceof WooCommerceLandingRefusal ? { said: err.said } : {}),
      });
    }
  }
  return result;
}

/**
 * Probe a credential that is not stored yet — the connect-time check.
 *
 * Two reads, in this order, so each failure says something different: the unauthenticated `wc/v3`
 * index (is there a WooCommerce store at this address?), then the store's own status with the key
 * (does this key read THIS store, and which store is it?). The answer names the store by the URL
 * WordPress reports for itself, which is what tells a person they pasted the key for the shop they
 * meant.
 */
export async function probeWooCommerceSecret(
  secret: Record<string, string>,
  options: WooCommerceConnectorOptions,
): Promise<ConnectionProbe> {
  const parsed = woocommerceSecret.safeParse(secret);
  if (!parsed.success) {
    return failed(true, `incomplete WooCommerce credential: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  }
  try {
    storeBaseUrl(parsed.data.storeUrl, { allowLocalHttp: options.allowLocalHttp });
  } catch (err) {
    return failed(false, err instanceof StoreUrlError ? err.message : String(err));
  }
  return probeWith(candidateConnection(parsed.data, options), options);
}

/** A credential that is not stored yet, as the API client takes one. */
function candidateConnection(secret: WooCommerceSecret, options: WooCommerceConnectorOptions): ConnectorConnection {
  return {
    id: connectionIdSchema.parse('00000000000000000000000000'), // no row yet; never read
    tenantId: '',
    vertical: '',
    provider: 'woocommerce',
    secret,
    // A REST API key does not expire; it is revoked in WooCommerce.
    expiresAt: null,
    fetch: deadlineFetch(options.fetch, options.timeoutMs ?? 15_000),
  };
}

/**
 * The store a key reads ({@link woocommerceStoreRef}), from what the store says of itself: its
 * `home_url`, else its `site_url`, else the address the key was pasted with, which it demonstrably
 * reads. What a connection is keyed on (#3219).
 */
function storeRefOf(info: WcStoreInfo, secret: WooCommerceSecret, options: WooCommerceConnectorOptions): string | null {
  return (
    woocommerceStoreRef(info.environment.home_url || info.environment.site_url) ??
    woocommerceStoreRef(storeBaseUrl(secret.storeUrl, { allowLocalHttp: options.allowLocalHttp }))
  );
}

/** Probe the credential a live connection already holds. Verifying is itself a use. */
export async function probeWooCommerceConnection(
  host: ScopeHost,
  connection: WooCommerceConnectionRef,
  options: WooCommerceConnectorOptions,
): Promise<ConnectionProbe> {
  const conn = await openWooCommerceConnection(
    host.admin,
    options.fetch,
    connection.tenantId,
    connection.vertical,
    options.timeoutMs ?? 15_000,
    { account: connection.externalAccountRef, owner: connection.ownerScopeId, expected: connection.id },
  );
  return probeWith(conn, options);
}

const failed = (refused: boolean, error: string): ConnectionProbe => ({
  ok: false,
  refused,
  accountRef: null,
  accountLabel: null,
  facts: [],
  error: error.slice(0, 600),
});

const clip = (s: string, n = 200): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

async function probeWith(conn: ConnectorConnection, options: WooCommerceConnectorOptions): Promise<ConnectionProbe> {
  // A probe answers a person waiting on a form: a 429 is "busy, try again", not a wait.
  const api = new WooCommerceApi(conn, { sleep: options.sleep, maxRateLimitRetries: 0, allowLocalHttp: options.allowLocalHttp });
  try {
    await api.index();
  } catch (err) {
    const notStore = err instanceof WooCommerceApiError && err.notStore;
    return failed(false, notStore ? `no WooCommerce store at ${api.base()}: ${(err as Error).message}` : String((err as Error).message ?? err));
  }
  try {
    const info = await api.storeInfo();
    const site = info.environment.home_url || info.environment.site_url;
    return {
      ok: true,
      refused: false,
      // The store, which the platform makes the connection's `externalAccountRef` (#3219): a key for
      // the same store rotates its connection, a key for another store is a connection of its own.
      accountRef: storeRefOf(info, woocommerceSecret.parse(conn.secret), options),
      accountLabel: site === '' ? null : clip(site),
      facts: [
        { label: 'Store', value: clip(site || api.base()) },
        { label: 'WooCommerce', value: clip(info.environment.version || 'unknown version') },
        { label: 'Currency', value: clip(info.settings.currency || 'not set') },
      ],
      error: null,
    };
  } catch (err) {
    const refused = err instanceof WooCommerceApiError && err.refused;
    const message = err instanceof Error ? err.message : String(err);
    return failed(
      refused,
      refused
        ? `${message} — the key needs Read permission and must belong to an administrator or a shop manager`
        : message,
    );
  }
}

/** What this connection has been doing, for a console — one entry per bound scope, from the ledger. */
export async function woocommerceConnectionActivity(host: ScopeHost, connectionId: ConnectionId): Promise<ConnectionActivity> {
  const rows = await host.admin.listConnectorState(connectionId, BINDING_PREFIX);
  const entries = rows
    .filter(({ value }) => value !== null && typeof value === 'object')
    .map(({ key, value }) => {
      const b = value as WooCommerceBinding;
      const s = b.lastSync;
      return {
        key,
        title: `${b.vertical} — ${b.scopeId}`,
        reference: null,
        status: !s ? 'bound — not yet synced' : s.caughtUp ? 'synced' : 'catching up',
        at: instant.parse(s?.syncedAt ?? b.boundAt),
        facts: [
          { label: 'Lands through', value: b.operation },
          { label: 'Permission', value: b.permission },
          ...(s
            ? [
                { label: 'Products changed up to', value: s.products.at ?? '—' },
                { label: 'Orders changed up to', value: s.orders.at ?? '—' },
                { label: 'Last pass landed', value: `${s.landed.products} products, ${s.landed.orders} orders, ${s.landed.removed ?? 0} removals` },
                { label: 'Deletes reconciled', value: s.reconciledAt ?? '—' },
              ]
            : []),
        ],
      };
    });
  return connectionActivity.parse({ source: 'ledger', entries, live: false });
}

/**
 * The platform's preparation of a candidate key (`ConnectionInspector.prepareCandidate`), run before
 * the key is stored, on every way a key reaches a connection. It pins the key to the store it reads
 * ({@link woocommerceStoreRef}), stored with the key as `store`.
 *
 * On a replacement (`previous` is the live connection's credential) it refuses, before anything is
 * stored, a key for another store: nothing the connection keeps (each binding's cursor) is true of
 * that one. The platform keys a WooCommerce connection on the store its probe names (#3219), so
 * `previous` is the same store's credential and this holds trivially — except for a connection made
 * before that, which holds no store and is still shown as `previous` to every key. Such a credential
 * carries no `store` either, so it is judged by the address it was pasted with: the same store if
 * that names the store the new key reads, or the address the new key was pasted with. Refusing
 * otherwise is what stops another store's key replacing it; disconnected, the next key makes a keyed
 * connection.
 *
 * A store that does not answer is a 503, nothing stored: unpinned, a later replacement could not be judged.
 */
export function prepareWooCommerceCandidate(
  options: WooCommerceConnectorOptions,
): (candidate: Record<string, string>, previous: Record<string, string> | undefined) => Promise<{ secret: Record<string, string> }> {
  return async (candidate, previous) => {
    const parsed = woocommerceSecret.safeParse(candidate);
    if (!parsed.success) {
      throw new WooCommerceKeyRefusal(`incomplete WooCommerce credential: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`, 422);
    }
    const api = new WooCommerceApi(candidateConnection(parsed.data, options), {
      sleep: options.sleep,
      maxRateLimitRetries: 0,
      allowLocalHttp: options.allowLocalHttp,
    });
    let store: string | null;
    try {
      store = storeRefOf(await api.storeInfo(), parsed.data, options);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof WooCommerceApiError && err.refused) throw new WooCommerceKeyRefusal(message, 422);
      if (err instanceof StoreUrlError) throw new WooCommerceKeyRefusal(message, 422);
      throw new WooCommerceKeyRefusal(`the store did not say which store it is, so nothing was stored; try again in a moment (${clip(message)})`, 503);
    }
    if (store === null) throw new WooCommerceKeyRefusal('the store did not name its own address, so nothing was stored', 422);
    if (previous !== undefined) {
      const asNew = 'a connection stays on one store, so disconnect it, then connect again with this key';
      const pinned = previous.store;
      const pasted = typeof previous.storeUrl === 'string' ? woocommerceStoreRef(previous.storeUrl) : null;
      const same = pinned !== undefined ? pinned === store : pasted !== null && (pasted === store || pasted === woocommerceStoreRef(parsed.data.storeUrl));
      if (!same) {
        throw new WooCommerceKeyRefusal(`this key reads the store at ${store}, and this connection is for ${pinned ?? pasted ?? 'another store'}; ${asNew}`, 422);
      }
    }
    return { secret: { storeUrl: parsed.data.storeUrl, consumerKey: parsed.data.consumerKey, consumerSecret: parsed.data.consumerSecret, store } };
  };
}

/** A key {@link prepareWooCommerceCandidate} will not store, with the status the relay answers. */
export class WooCommerceKeyRefusal extends Error {
  readonly status: 422 | 503;
  constructor(message: string, status: 422 | 503) {
    super(message);
    this.name = 'WooCommerceKeyRefusal';
    this.status = status;
  }
}

/** The stored credential, reduced: the store URL in full, the key and secret masked. */
export async function woocommerceCredentialSummary(host: ScopeHost, connection: WooCommerceConnectionRef): Promise<ConnectionCredential> {
  const open = await openWooCommerceCredential(host.admin, connection.tenantId, connection.vertical, {
    account: connection.externalAccountRef,
    owner: connection.ownerScopeId,
    expected: connection.id,
  });
  const secret = woocommerceSecret.parse(open.secret);
  return {
    fields: [
      { key: 'storeUrl', label: 'Store URL', value: clip(secret.storeUrl), masked: false },
      { key: 'consumerKey', label: 'Consumer key', value: maskSecret(secret.consumerKey), masked: true },
      { key: 'consumerSecret', label: 'Consumer secret', value: maskSecret(secret.consumerSecret), masked: true },
    ],
  };
}

const maskSecret = (value: string): string => (value.length < 8 ? '••••••••' : `••••••••${value.slice(-4)}`);

/**
 * A WooCommerce connection as a caller knows it: its tenant and vertical, and — where the caller
 * holds the row — its id, its `externalAccountRef` (the store it is keyed on, #3219) and its
 * `ownerScopeId` (the scope it is the own connection of, #3201).
 */
export interface WooCommerceConnectionRef {
  id?: ConnectionId;
  tenantId: string;
  vertical: string;
  externalAccountRef?: string | null;
  ownerScopeId?: string | null;
}

type Select = { account?: string | null; owner?: string | null; expected?: ConnectionId };

/**
 * Open one WooCommerce connection's credential (#3219).
 *
 * A tenant may connect several stores to one app, one connection each, keyed on the store
 * (`externalAccountRef`), so a read that names no store throws once there are two. `account` names
 * it: the connection's own ref where the caller holds the row, else the store its binding records.
 * With no connection on that store — a connection made before connections were keyed holds none, and
 * is then the app's only one — the read names no store.
 *
 * `owner` opens a scope's OWN connection (#3201); without it only the tenant's is ever opened, so
 * a scope's own credential is never read for another scope or for the tenant.
 *
 * `expected` is the connection the caller acts for. The credential that reads and the identity that
 * lands must be the same connection (Planima's backstop, for the same reason), so whatever the store
 * found, another connection is refused.
 */
async function openWooCommerceCredential(admin: HostAdmin, tenant: string, vertical: string, select: Select): Promise<OpenConnection> {
  const t = tenantIdSchema.parse(tenant);
  const owner = select.owner ? scopeIdSchema.parse(select.owner) : undefined;
  const open =
    (select.account ? await admin.openConnection(t, vertical, 'woocommerce', select.account, owner) : undefined) ??
    (await admin.openConnection(t, vertical, 'woocommerce', undefined, owner));
  if (!open) throw new Error(`no live 'woocommerce' connection for tenant ${tenant} / vertical '${vertical}'`);
  if (select.expected !== undefined && open.id !== select.expected) {
    throw new Error(
      `binding names connection ${select.expected}, but the live 'woocommerce' connection for tenant ${tenant} / ` +
        `vertical '${vertical}' is ${open.id}. Re-bind the scope against ${open.id}.`,
    );
  }
  return open;
}

/** {@link openWooCommerceCredential}, with health recorded on every call it makes. */
async function openWooCommerceConnection(
  admin: HostAdmin,
  fetchImpl: FetchLike,
  tenant: string,
  vertical: string,
  timeoutMs: number,
  select: Select = {},
): Promise<ConnectorConnection> {
  const open = await openWooCommerceCredential(admin, tenant, vertical, select);
  const bounded = deadlineFetch(fetchImpl, timeoutMs);
  return {
    ...open,
    fetch: async (input, init) => {
      const started = Date.now();
      try {
        const res = await bounded(input, init);
        await admin.recordConnectionUse(open.id, settleConnectionUse('woocommerce', Date.now() - started, { response: res }));
        return res;
      } catch (err) {
        await admin.recordConnectionUse(open.id, settleConnectionUse('woocommerce', Date.now() - started, { error: err }));
        throw err;
      }
    },
  };
}
