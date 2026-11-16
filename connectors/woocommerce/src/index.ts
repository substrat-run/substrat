import {
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
import type { ConnectorConnection, FetchLike, HostAdmin, ScopeHost } from '@substrat-run/kernel';
import { deadlineFetch, settleConnectionUse } from '@substrat-run/kernel';
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
 * - **Deletes.** A deleted product or order is not in a "changed since" list. Only upserts land.
 * - **Stock.** Not in the commerce shape yet (see its "What is NOT here").
 * - **Draft checkouts** (`checkout-draft`): a cart the block checkout saved, not an order. Skipped.
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
    landed: { products: number; orders: number };
  };
}

export interface WooCommerceConnectorOptions {
  fetch: FetchLike;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Pages per resource per sync; {@link WOOCOMMERCE_PAGES_PER_SYNC} by default. */
  pagesPerSync?: number;
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
  const scope = await host.getConnectorScope(connectionId, scopeIdSchema.parse(binding.scopeId));

  const products: Walk = { cursor: binding.lastSync?.products ?? { at: null, landedAt: [] }, landed: 0, caughtUp: false };
  const orders: Walk = { cursor: binding.lastSync?.orders ?? { at: null, landedAt: [] }, landed: 0, caughtUp: false };
  const save = async (): Promise<void> => {
    const caughtUp = products.caughtUp && orders.caughtUp;
    const moved =
      products.cursor !== binding.lastSync?.products || orders.cursor !== binding.lastSync?.orders;
    // An idle pass writes nothing: most passes find a store nobody has touched.
    if (!moved && binding.lastSync?.caughtUp === caughtUp) return;
    const synced: WooCommerceBinding = {
      ...binding,
      lastSync: {
        syncedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
        products: products.cursor,
        orders: orders.cursor,
        caughtUp,
        landed: { products: products.landed, orders: orders.landed },
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
        return true;
      },
      orders,
      pages,
    );
  } catch (err) {
    // Keep what did land, so the next pass resumes after it instead of landing it all again.
    await save();
    throw err;
  }
  await save();
  return {
    scopeId: binding.scopeId,
    changed: products.landed + orders.landed > 0,
    products: products.landed,
    orders: orders.landed,
    caughtUp: products.caughtUp && orders.caughtUp,
  };
}

function storeCurrency(value: string): CurrencyCode {
  const parsed = currencyCode.safeParse(value.toUpperCase());
  if (!parsed.success) throw new WooCommerceApiError(`the store's currency '${value}' is not an ISO 4217 code`, 502);
  return parsed.data;
}

export interface WooCommerceSweepResult {
  found: number;
  synced: WooCommerceSyncResult[];
  unchanged: number;
  failed: { scopeId: string; error: string }[];
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
      result.failed.push({ scopeId: binding.scopeId, error: err instanceof Error ? err.message : String(err) });
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
                { label: 'Last pass landed', value: `${s.landed.products} products, ${s.landed.orders} orders` },
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
