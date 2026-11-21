import { z } from 'zod';
import type { ConnectorConnection } from '@substrat-run/kernel';
import { shopDomain } from './shop-domain.js';

// The default `sleep` only. Every caller inside the platform injects its own, and a test always does.
declare const setTimeout: (handler: () => void, timeout: number) => unknown;

/**
 * A thin, typed client over Shopify's Admin GraphQL API. Every call goes through the connection's
 * `fetch`, never a global one: that is what gets it a timeout, an egress policy, and health recorded
 * against the right connection.
 *
 * ## The credential, and why no access token is stored
 *
 * Since 1 January 2026 a merchant can no longer make the admin "custom app" whose page showed a
 * permanent `shpat_` token. What replaces it is an app in Shopify's Dev Dashboard, installed on the
 * merchant's own store, whose Settings show a **client ID and a client secret**. Those are what a
 * connection holds. Each unit of work mints an access token from them with OAuth's client-credentials
 * grant (a form POST to the shop's `/admin/oauth/access_token`), which Shopify answers with a token
 * that lasts about a day; it is kept in memory for that unit of work only and never stored, so there
 * is no refresh to get wrong and nothing to rotate. Shopify grants this only for an app and a store
 * in the same organization, which is exactly the case of a merchant's own app on their own store.
 *
 * ## The API
 *
 * One endpoint, `POST /admin/api/<version>/graphql.json`, with the token in `X-Shopify-Access-Token`.
 * The version is pinned ({@link SHOPIFY_API_VERSION}) because Shopify removes a version a year after
 * it ships; moving it is a deliberate change with the live test run against it. Rate limiting is by
 * query cost: a throttled query answers `200` with a `THROTTLED` error and the bucket's restore rate,
 * and the client waits for what it needs. A single query may not REQUEST more than 1 000 points, and
 * Shopify refuses one that does before running it (`MAX_COST_EXCEEDED`); the page sizes below are
 * estimated to stay under it, and a changed-list page that is refused anyway is asked again at half
 * the size (see {@link ShopifyApi.changedPage}), so an estimate that proves low slows a pass rather
 * than stopping every one.
 */
export const SHOPIFY_API_VERSION = '2026-10';

/**
 * Products per changed-list page. By Shopify's documented rules (an object is 1 point; a connection is
 * 2 plus `first` times its node), a product is 1 + its variants connection 2 + 10 × (variant 1 +
 * inventoryItem 1 + up to 3 selected options) ≈ 53, so a page of 15 requests about 800. ESTIMATED,
 * not measured: `test/live.test.ts` asserts a full page's reported cost against a real shop.
 */
export const SHOPIFY_PRODUCTS_PAGE = 15;
/**
 * Orders per changed-list page. An order is 1 + customer 1 + two addresses 2 + four money bags with
 * their `presentmentMoney` 8 + up to 10 transactions 10 + its lines connection 2 + 10 × (line 1 +
 * product 1 + variant 1 + original total 2 + discount and tax entries, counted at 2 each and
 * 3 points apiece, 12) ≈ 194 at the outside, ≈ 74 counting the discount and tax lists as nothing; a
 * page of 4 requests about 780 by the first count and 300 by the second. ESTIMATED as the products'
 * is, and measured the same way.
 */
export const SHOPIFY_ORDERS_PAGE = 4;
/** Variants or lines read with their product or order; the rest are read on their own, 100 at a time. */
export const SHOPIFY_NESTED_PAGE = 10;
/** Ids asked about in one `nodes` query (Shopify takes up to 250). */
export const SHOPIFY_NODES_PAGE = 100;

/**
 * A Shopify connection's credential: the shop, and the client ID and secret of the Dev Dashboard app
 * installed on it. The app needs the `read_products` and `read_orders` scopes; `read_all_orders`
 * (which Shopify grants on request) lets it read orders older than 60 days, and `read_customers`
 * lets an order name the customer account it was placed by.
 */
export const shopifySecret = z.object({
  shop: z.string().min(1),
  clientId: z.string().regex(/^[\x21-\x7e]+$/, 'printable ASCII only'),
  clientSecret: z.string().regex(/^[\x21-\x7e]+$/, 'printable ASCII only'),
});
export type ShopifySecret = z.infer<typeof shopifySecret>;

/** The scopes a sync cannot run without. */
export const SHOPIFY_REQUIRED_SCOPES = ['read_products', 'read_orders'] as const;

/**
 * A Shopify API failure, with what a caller branches on.
 *
 * - `refused`: Shopify said "not with this credential" — the token mint refused the client, the API
 *   refused the token, or the app lacks a scope the query needs (`ACCESS_DENIED`).
 * - `notStore`: there is no shop at that address (a 404 from the token endpoint, a page that is not
 *   JSON). Says nothing about the credential.
 * - `shopWide`: a status that holds for every record of the shop — a rate limit Shopify kept
 *   answering, a shop frozen for an unpaid bill (402) or locked (423).
 *
 * Messages carry Shopify's own error text and code, never a request's headers or body, so no message
 * here can carry the client secret or a token.
 */
export class ShopifyApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly refused: boolean;
  readonly notStore: boolean;
  readonly shopWide: boolean;
  constructor(message: string, status: number, code: string | null = null, flags: { refused?: boolean; notStore?: boolean } = {}) {
    super(message);
    this.name = 'ShopifyApiError';
    this.status = status;
    this.code = code;
    this.refused = flags.refused ?? (status === 401 || status === 403);
    this.notStore = flags.notStore ?? false;
    this.shopWide = this.refused || this.notStore || status === 429 || status === 402 || status === 423;
  }
}

// Provider shapes. Extra fields are ignored. Shopify sends a blank as `null`, so every optional field
// reads `null` and absent alike. A protected field the app may NOT read is different: Shopify fails the
// whole query with `ACCESS_DENIED` rather than answering `null`, which is why the probe runs the sync's
// own order query (`ordersReadable`) before a connection is trusted.
const nullableStr = () => z.string().nullable().optional().transform((v) => (v === undefined || v === null || v === '' ? null : v));
const blankStr = () => z.string().nullable().optional().transform((v) => v ?? '');
/** A Shopify `Decimal` or `Money` scalar: a decimal string. Mapped, not parsed, here. */
const decimal = () => z.union([z.string(), z.number()]).transform((v) => String(v));
const money = z.object({ presentmentMoney: z.object({ amount: decimal(), currencyCode: z.string() }) });
const page = <T extends z.ZodTypeAny>(node: T) => z.object({ nodes: z.array(node), pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }) });

export const shopifyVariant = z.object({
  id: z.string(),
  sku: nullableStr(),
  title: blankStr(),
  price: decimal().nullable(),
  compareAtPrice: decimal().nullable().optional().transform((v) => v ?? null),
  selectedOptions: z.array(z.object({ name: blankStr(), value: blankStr() })).optional().transform((v) => v ?? []),
  /** The sum over every location; `null` when the store does not track it. */
  inventoryQuantity: z.number().nullable().optional().transform((v) => v ?? null),
  /** `DENY`: stop selling at zero. `CONTINUE`: keep selling, which is a backorder. */
  inventoryPolicy: blankStr(),
  inventoryItem: z.object({ tracked: z.boolean().nullable().optional().transform((v) => v ?? false) }).nullable().optional().transform((v) => v ?? { tracked: false }),
});
export type ShopifyVariant = z.infer<typeof shopifyVariant>;

export const shopifyProduct = z.object({
  id: z.string(),
  title: blankStr(),
  handle: nullableStr(),
  /** `ACTIVE`, `DRAFT`, `ARCHIVED`, or (later versions) a new word. */
  status: blankStr(),
  onlineStoreUrl: nullableStr(),
  /** True for a product sold without options: its one variant is Shopify's "Default Title". */
  hasOnlyDefaultVariant: z.boolean(),
  createdAt: nullableStr(),
  updatedAt: z.string(),
  variants: page(shopifyVariant),
});
export type ShopifyProduct = z.infer<typeof shopifyProduct>;

export const shopifyAddress = z.object({
  firstName: blankStr(),
  lastName: blankStr(),
  company: blankStr(),
  address1: blankStr(),
  address2: blankStr(),
  city: blankStr(),
  province: blankStr(),
  provinceCode: blankStr(),
  zip: blankStr(),
  countryCodeV2: blankStr(),
  phone: nullableStr(),
});
export type ShopifyAddress = z.infer<typeof shopifyAddress>;

export const shopifyLineItem = z.object({
  id: z.string(),
  name: blankStr(),
  sku: nullableStr(),
  quantity: z.number(),
  product: z.object({ id: z.string() }).nullable().optional().transform((v) => v ?? null),
  variant: z.object({ id: z.string() }).nullable().optional().transform((v) => v ?? null),
  /** Quantity × the unit price before any discount; tax included when the order's prices include it. */
  originalTotalSet: money,
  /** Every discount on the line, its own and its share of the order's. */
  discountAllocations: z.array(z.object({ allocatedAmountSet: money })).optional().transform((v) => v ?? []),
  taxLines: z.array(z.object({ rate: z.union([z.number(), z.string()]).nullable().optional().transform((v) => (v === undefined || v === null ? null : String(v))), priceSet: money })).optional().transform((v) => v ?? []),
});
export type ShopifyLineItem = z.infer<typeof shopifyLineItem>;

export const shopifyOrder = z.object({
  id: z.string(),
  /** The number a customer sees, `#1001`. */
  name: blankStr(),
  createdAt: nullableStr(),
  updatedAt: z.string(),
  processedAt: nullableStr(),
  cancelledAt: nullableStr(),
  /** `PAID`, `PENDING`, `PARTIALLY_PAID`, `REFUNDED`, `VOIDED`, … */
  displayFinancialStatus: blankStr(),
  taxesIncluded: z.boolean(),
  presentmentCurrencyCode: z.string(),
  email: nullableStr(),
  phone: nullableStr(),
  note: nullableStr(),
  /** Asked for only when the app holds `read_customers`; absent otherwise. */
  customer: z.object({ id: z.string() }).nullable().optional().transform((v) => v ?? null),
  billingAddress: shopifyAddress.nullable().optional().transform((v) => v ?? null),
  shippingAddress: shopifyAddress.nullable().optional().transform((v) => v ?? null),
  totalPriceSet: money,
  totalTaxSet: money.nullable().optional().transform((v) => v ?? null),
  totalShippingPriceSet: money.nullable().optional().transform((v) => v ?? null),
  totalDiscountsSet: money.nullable().optional().transform((v) => v ?? null),
  transactions: z.array(z.object({ kind: blankStr(), status: blankStr(), processedAt: nullableStr() })).optional().transform((v) => v ?? []),
  lineItems: page(shopifyLineItem),
});
export type ShopifyOrder = z.infer<typeof shopifyOrder>;

export const shopifyShopInfo = z.object({
  shop: z.object({
    id: z.string(),
    name: blankStr(),
    myshopifyDomain: z.string(),
    currencyCode: z.string(),
    primaryDomain: z.object({ url: blankStr() }).nullable().optional().transform((v) => v ?? null),
  }),
  currentAppInstallation: z.object({ accessScopes: z.array(z.object({ handle: z.string() })) }),
});
export type ShopifyShopInfo = z.infer<typeof shopifyShopInfo>;

// The queries. Named, because the mock answers by operation name; small, because a query's cost is
// its page sizes multiplied through.
const VARIANT = `fragment V on ProductVariant {
  id sku title price compareAtPrice selectedOptions { name value }
  inventoryQuantity inventoryPolicy inventoryItem { tracked }
}`;
const PRODUCT = `fragment P on Product {
  id title handle status onlineStoreUrl hasOnlyDefaultVariant createdAt updatedAt
  variants(first: ${SHOPIFY_NESTED_PAGE}) { nodes { ...V } pageInfo { hasNextPage endCursor } }
}
${VARIANT}`;
const MONEY = '{ presentmentMoney { amount currencyCode } }';
const ADDRESS = 'firstName lastName company address1 address2 city province provinceCode zip countryCodeV2 phone';
const LINE = `fragment L on LineItem {
  id name sku quantity product { id } variant { id }
  originalTotalSet ${MONEY}
  discountAllocations { allocatedAmountSet ${MONEY} }
  taxLines { rate priceSet ${MONEY} }
}`;
const ORDER = `fragment O on Order {
  id name createdAt updatedAt processedAt cancelledAt displayFinancialStatus taxesIncluded
  presentmentCurrencyCode email phone note
  customer @include(if: $customers) { id }
  billingAddress { ${ADDRESS} } shippingAddress { ${ADDRESS} }
  totalPriceSet ${MONEY} totalTaxSet ${MONEY} totalShippingPriceSet ${MONEY} totalDiscountsSet ${MONEY}
  transactions(first: 10) { kind status processedAt }
  lineItems(first: ${SHOPIFY_NESTED_PAGE}) { nodes { ...L } pageInfo { hasNextPage endCursor } }
}
${LINE}`;

const QUERIES = {
  ShopInfo: `query ShopInfo {
  shop { id name myshopifyDomain currencyCode primaryDomain { url } }
  currentAppInstallation { accessScopes { handle } }
}`,
  ChangedProducts: `query ChangedProducts($first: Int!, $after: String, $query: String) {
  products(first: $first, after: $after, sortKey: UPDATED_AT, query: $query) { nodes { ...P } pageInfo { hasNextPage endCursor } }
}
${PRODUCT}`,
  ChangedOrders: `query ChangedOrders($first: Int!, $after: String, $query: String, $customers: Boolean!) {
  orders(first: $first, after: $after, sortKey: UPDATED_AT, query: $query) { nodes { ...O } pageInfo { hasNextPage endCursor } }
}
${ORDER}`,
  Product: `query Product($id: ID!) { product(id: $id) { ...P } }
${PRODUCT}`,
  Order: `query Order($id: ID!, $customers: Boolean!) { order(id: $id) { ...O } }
${ORDER}`,
  MoreVariants: `query MoreVariants($id: ID!, $after: String) {
  product(id: $id) { variants(first: 100, after: $after) { nodes { ...V } pageInfo { hasNextPage endCursor } } }
}
${VARIANT}`,
  MoreLineItems: `query MoreLineItems($id: ID!, $after: String) {
  order(id: $id) { lineItems(first: 100, after: $after) { nodes { ...L } pageInfo { hasNextPage endCursor } } }
}
${LINE}`,
  Present: `query Present($ids: [ID!]!) { nodes(ids: $ids) { id } }`,
} as const;
export type ShopifyOperation = keyof typeof QUERIES;

export type ShopifyResource = 'products' | 'orders';
const GID_TYPE: Record<ShopifyResource, string> = { products: 'Product', orders: 'Order' };

/** A record's global id, `gid://shopify/Product/123`. */
export function gidOf(type: string, id: number): string {
  return `gid://shopify/${type}/${id}`;
}

/** The numeric id at the end of a Shopify global id of `type`, or `null` when it is not one. */
export function idOfGid(gid: string, type: string): number | null {
  const m = /^gid:\/\/shopify\/([A-Za-z]+)\/(\d+)(?:\?.*)?$/.exec(gid);
  if (!m || m[1] !== type) return null;
  const n = Number(m[2]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export interface ShopifyApiOptions {
  /** Injected so a test can wait through a throttle without sleeping. */
  sleep?: (ms: number) => Promise<void>;
  /** How many throttled answers in a row a request sits out. Zero disables the wait, which is what a probe wants. */
  maxRateLimitRetries?: number;
  now?: () => number;
  /** Told each answered operation's requested query cost, as Shopify reports it. For the live test's measurement. */
  onCost?: (operation: ShopifyOperation, requestedQueryCost: number) => void;
}

/** A throttle with no usable restore rate waits this long; a longer computed wait is capped at three times it. */
const DEFAULT_RETRY_MS = 2_000;
/** Re-mint this long before the token's expiry, so it never dies mid-pass. */
const EXPIRY_SKEW_MS = 60_000;

interface GraphQlError {
  message?: unknown;
  extensions?: { code?: unknown };
}

/** `application/x-www-form-urlencoded`, built by hand: this package declares no DOM typings. */
function form(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

const clip = (s: string, n = 300): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export class ShopifyApi {
  private readonly conn: ConnectorConnection;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRateLimitRetries: number;
  private readonly now: () => number;
  private readonly onCost: ShopifyApiOptions['onCost'];
  private token: { value: string; expiresAtMs: number } | null = null;
  /** The changed-list page size, halved for the rest of this instance's life by a `MAX_COST_EXCEEDED`. */
  private readonly pageSize: Record<ShopifyResource, number> = { products: SHOPIFY_PRODUCTS_PAGE, orders: SHOPIFY_ORDERS_PAGE };
  /** The scopes the last mint granted, or `null` before one. */
  grantedScopes: string[] | null = null;

  constructor(conn: ConnectorConnection, options?: ShopifyApiOptions) {
    this.conn = conn;
    this.sleep = options?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRateLimitRetries = options?.maxRateLimitRetries ?? 3;
    this.now = options?.now ?? (() => Date.now());
    this.onCost = options?.onCost;
  }

  private secret(): ShopifySecret {
    const parsed = shopifySecret.safeParse(this.conn.secret);
    if (!parsed.success) {
      // Names the fields, never their values.
      throw new ShopifyApiError(`incomplete Shopify credential: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`, 400, null, { refused: false });
    }
    return parsed.data;
  }

  /** The shop's `<handle>.myshopify.com`, after {@link shopDomain} has judged it. */
  shop(): string {
    return shopDomain(this.secret().shop);
  }

  /** Mint a token from the client credentials, or answer the one this instance already holds. */
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAtMs - this.now() > EXPIRY_SKEW_MS) return this.token.value;
    const { clientId, clientSecret } = this.secret();
    const res = await this.conn.fetch(`https://${this.shop()}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: form({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
    });
    const body = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      // Shopify's "this store is unavailable" page, or no Shopify at all.
      throw new ShopifyApiError(`the token endpoint at ${this.shop()} answered ${res.status} with a page, not JSON`, res.status === 200 ? 502 : res.status, null, { notStore: true, refused: false });
    }
    if (!res.ok) {
      const e = json as { error?: unknown; error_description?: unknown; errors?: unknown };
      const code = typeof e.error === 'string' ? e.error : null;
      const said = [e.error_description, e.errors, e.error].find((v) => typeof v === 'string') as string | undefined;
      throw new ShopifyApiError(
        `Shopify refused to mint a token (${res.status}${code ? ` ${code}` : ''}): ${clip(said ?? `HTTP ${res.status}`)}`,
        res.status,
        code,
        // RFC 6749 §5.2: a bad client is a 400 as often as a 401. A 404 is no such shop.
        res.status === 404 ? { notStore: true, refused: false } : { refused: res.status === 400 || res.status === 401 || res.status === 403 },
      );
    }
    const parsed = z.object({ access_token: z.string().min(1), scope: z.string().optional(), expires_in: z.number().optional() }).safeParse(json);
    if (!parsed.success) throw new ShopifyApiError('the token endpoint answered without an access token', 502);
    this.grantedScopes = (parsed.data.scope ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
    // About a day; assumed an hour when unstated, which only costs a re-mint.
    this.token = { value: parsed.data.access_token, expiresAtMs: this.now() + (parsed.data.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  /** One GraphQL operation, through throttling and one re-mint of a token Shopify refused. */
  async graphql(operation: ShopifyOperation, variables: Record<string, unknown> = {}): Promise<unknown> {
    const url = `https://${this.shop()}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
    let reminted = false;
    for (let attempt = 0; ; attempt += 1) {
      const token = await this.accessToken();
      const res = await this.conn.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ operationName: operation, query: QUERIES[operation], variables }),
      });
      const body = await res.text();
      if (res.status === 401 && !reminted) {
        // A token Shopify revoked early is not a refused client: mint once more before saying so.
        this.token = null;
        reminted = true;
        continue;
      }
      if (res.status === 429 && attempt < this.maxRateLimitRetries) {
        await this.sleep(retryAfterMs(res.headers?.get('Retry-After') ?? null));
        continue;
      }
      const json = graphQlBody(body);
      if (!res.ok) {
        const said = typeof json?.errors === 'string' ? json.errors : `HTTP ${res.status}`;
        throw new ShopifyApiError(`Shopify ${operation} failed (${res.status}): ${clip(said)}`, res.status, null, res.status === 404 ? { notStore: true, refused: false } : {});
      }
      if (json === null) throw new ShopifyApiError(`Shopify ${operation} answered a page that is not JSON`, 502, null, { notStore: true, refused: false });
      const errors = Array.isArray(json.errors) ? (json.errors as GraphQlError[]) : [];
      if (errors.length > 0) {
        const code = errors.map((e) => (typeof e.extensions?.code === 'string' ? e.extensions.code : null)).find((c) => c !== null) ?? null;
        if (code === 'THROTTLED' && attempt < this.maxRateLimitRetries) {
          await this.sleep(throttleWaitMs(json.extensions));
          continue;
        }
        const message = errors.map((e) => (typeof e.message === 'string' ? e.message : 'error')).join('; ');
        const status = code === 'THROTTLED' ? 429 : code === 'ACCESS_DENIED' ? 403 : 502;
        throw new ShopifyApiError(`Shopify ${operation} failed${code ? ` (${code})` : ''}: ${clip(message)}`, status, code);
      }
      if (json.data === undefined || json.data === null) throw new ShopifyApiError(`Shopify ${operation} answered no data`, 502);
      const requested = Number((json.extensions as { cost?: { requestedQueryCost?: unknown } } | undefined)?.cost?.requestedQueryCost);
      if (this.onCost && Number.isFinite(requested)) this.onCost(operation, requested);
      return json.data;
    }
  }

  /** The shop's own name, domain and currency, and the scopes the app holds. */
  async shopInfo(): Promise<ShopifyShopInfo> {
    const parsed = shopifyShopInfo.safeParse(await this.graphql('ShopInfo'));
    if (!parsed.success) throw new ShopifyApiError('the shop query did not answer the shop', 502);
    return parsed.data;
  }

  /**
   * One page of products or orders changed at or after `updatedFrom` (UTC, `…Z`), oldest change
   * first, continuing from the GraphQL cursor `after`. Rows are unparsed, as the walk reads them one
   * by one. `customers` asks an order for its customer account (needs `read_customers`).
   *
   * A page Shopify refuses as too costly (`MAX_COST_EXCEEDED`) is asked again at half the size, down
   * to one row, and the smaller size is kept for the rest of this pass. The GraphQL cursor does not
   * depend on the page size, so the walk reads on from the same place.
   */
  async changedPage(
    resource: ShopifyResource,
    updatedFrom: string | null,
    after: string | null,
    customers: boolean,
  ): Promise<{ nodes: unknown[]; hasNextPage: boolean; endCursor: string | null }> {
    const query = updatedFrom === null ? null : `updated_at:>='${updatedFrom}'`;
    let data: unknown;
    for (;;) {
      const first = this.pageSize[resource];
      try {
        data =
          resource === 'products'
            ? ((await this.graphql('ChangedProducts', { first, after, query })) as { products?: unknown })?.products
            : ((await this.graphql('ChangedOrders', { first, after, query, customers })) as { orders?: unknown })?.orders;
        break;
      } catch (err) {
        if (!(err instanceof ShopifyApiError && err.code === 'MAX_COST_EXCEEDED' && first > 1)) throw err;
        this.pageSize[resource] = Math.ceil(first / 2);
      }
    }
    const parsed = z.object({ nodes: z.array(z.unknown()), pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }) }).safeParse(data);
    if (!parsed.success) throw new ShopifyApiError(`Shopify ${resource} list answered something other than a page`, 502);
    return { nodes: parsed.data.nodes, ...parsed.data.pageInfo };
  }

  /**
   * Whether the sync's own order query is answered: the same `ChangedOrders` operation, one row.
   * Name, email, phone and address on an order are protected customer data, granted on the Dev
   * Dashboard app apart from the `read_orders` scope; without that access Shopify refuses the query
   * with `ACCESS_DENIED`, which this throws as every query does. The probe asks it so that a
   * connection whose sweeps would all fail on orders is not shown as connected.
   */
  async ordersReadable(customers: boolean): Promise<void> {
    await this.graphql('ChangedOrders', { first: 1, after: null, query: null, customers });
  }

  /** Which of `ids` (at most {@link SHOPIFY_NODES_PAGE}) the shop still holds — one query, ids only. */
  async presentIds(resource: ShopifyResource, ids: readonly number[]): Promise<Set<number>> {
    if (ids.length === 0) return new Set();
    if (ids.length > SHOPIFY_NODES_PAGE) throw new RangeError(`presentIds takes at most ${SHOPIFY_NODES_PAGE} ids`);
    const type = GID_TYPE[resource];
    const data = await this.graphql('Present', { ids: ids.map((id) => gidOf(type, id)) });
    const nodes = z.object({ nodes: z.array(z.object({ id: z.string() }).nullable()) }).safeParse(data);
    if (!nodes.success || nodes.data.nodes.length !== ids.length) {
      // `nodes` answers one entry per id asked, null for a missing one. Anything else is no answer.
      throw new ShopifyApiError(`Shopify answered ${resource} by id in a shape that does not say which are present`, 502);
    }
    const present = new Set<number>();
    for (const n of nodes.data.nodes) {
      const id = n === null ? null : idOfGid(n.id, type);
      if (id !== null) present.add(id);
    }
    return present;
  }

  /** One product or order as the changed list sends it, or `null` when the shop has no such record. */
  async record(resource: ShopifyResource, id: number, customers: boolean): Promise<unknown> {
    const gid = gidOf(GID_TYPE[resource], id);
    const data = (resource === 'products' ? await this.graphql('Product', { id: gid }) : await this.graphql('Order', { id: gid, customers })) as Record<string, unknown> | null;
    return data?.[resource === 'products' ? 'product' : 'order'] ?? null;
  }

  /** The variants of a product past the first page its product row carried. */
  async moreVariants(productGid: string, after: string): Promise<ShopifyVariant[]> {
    const rows: ShopifyVariant[] = [];
    for (let cursor: string | null = after; cursor !== null; ) {
      const data = (await this.graphql('MoreVariants', { id: productGid, after: cursor })) as { product?: { variants?: unknown } | null };
      const parsed = page(shopifyVariant).parse(data.product?.variants);
      rows.push(...parsed.nodes);
      cursor = parsed.pageInfo.hasNextPage ? parsed.pageInfo.endCursor : null;
    }
    return rows;
  }

  /** The lines of an order past the first page its order row carried. */
  async moreLineItems(orderGid: string, after: string): Promise<ShopifyLineItem[]> {
    const rows: ShopifyLineItem[] = [];
    for (let cursor: string | null = after; cursor !== null; ) {
      const data = (await this.graphql('MoreLineItems', { id: orderGid, after: cursor })) as { order?: { lineItems?: unknown } | null };
      const parsed = page(shopifyLineItem).parse(data.order?.lineItems);
      rows.push(...parsed.nodes);
      cursor = parsed.pageInfo.hasNextPage ? parsed.pageInfo.endCursor : null;
    }
    return rows;
  }
}

interface GraphQlBody {
  data?: unknown;
  errors?: unknown;
  extensions?: unknown;
}

/** The body as JSON, or `null` when it is not: a proxy's or Shopify's own error page. */
function graphQlBody(body: string): GraphQlBody | null {
  try {
    const json: unknown = JSON.parse(body);
    return json !== null && typeof json === 'object' ? (json as GraphQlBody) : null;
  } catch {
    return null;
  }
}

function retryAfterMs(header: string | null): number {
  const seconds = header === null ? Number.NaN : Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_RETRY_MS;
  return Math.min(seconds * 1000, DEFAULT_RETRY_MS * 3);
}

/** How long until the cost bucket holds what the throttled query asked for. */
function throttleWaitMs(extensions: unknown): number {
  const cost = (extensions as { cost?: { requestedQueryCost?: unknown; throttleStatus?: { currentlyAvailable?: unknown; restoreRate?: unknown } } } | null)?.cost;
  const wanted = Number(cost?.requestedQueryCost);
  const available = Number(cost?.throttleStatus?.currentlyAvailable);
  const rate = Number(cost?.throttleStatus?.restoreRate);
  if (![wanted, available, rate].every(Number.isFinite) || rate <= 0) return DEFAULT_RETRY_MS;
  return Math.min(Math.max(0, Math.ceil(((wanted - available) / rate) * 1000)), DEFAULT_RETRY_MS * 3);
}
