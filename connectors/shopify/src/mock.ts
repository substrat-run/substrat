import type { FetchLike } from '@substrat-run/kernel';
import { SHOPIFY_API_VERSION, SHOPIFY_NESTED_PAGE } from './api.js';

/** A product as Shopify's GraphQL answers it, with EVERY variant: the mock pages them. */
export type MockProduct = Record<string, unknown> & { id: string; updatedAt: string; variants: Record<string, unknown>[] };
/** An order as Shopify's GraphQL answers it, with EVERY line: the mock pages them. */
export type MockOrder = Record<string, unknown> & { id: string; updatedAt: string; createdAt: string; lineItems: Record<string, unknown>[] };

/**
 * A Shopify shop in memory — the token endpoint and the GraphQL operations the connector sends,
 * answered by operation name, enough to run the probe and the whole sync without a shop.
 *
 * **What a mock proves:** that our shape works — the client-credentials mint, the token header, the
 * keyset walk over `updated_at`, nested pages, the reconcile by id, the probe's outcomes. **What it
 * cannot prove:** that our reading of Shopify's API is right, or that our queries pass Shopify's
 * schema. The mock IS our reading; `test/live.test.ts` checks it against a real shop when one is
 * configured.
 *
 * Strict where a convenient mock would let a client be wrong while every test passes:
 *
 * 1. **The token is minted, then sent as `X-Shopify-Access-Token`.** The client secret on a GraphQL
 *    call, or a token this mock did not mint, is a 401; a minted token expires (`tokenLifetimeS`).
 * 2. **A page larger than 250 is refused**, as Shopify's `first` argument is.
 * 3. **The changed-list filter is `updated_at:>='…'` and nothing else**, so the walk is tested against
 *    the one search syntax it relies on; and the list is in `UPDATED_AT` order, ties by id, with a
 *    cursor that is the sort key, as Shopify's is.
 * 4. **Without `read_all_orders`, an order created more than 60 days before `now` does not exist** —
 *    not in a list, not by id, and `null` in `nodes` — as Shopify hides it, silently.
 * 5. **`customer` without `read_customers` is `ACCESS_DENIED`**, failing the whole query; so is any
 *    order query without protected customer data access (`protectedCustomerData: false`), since every
 *    order query asks for the buyer's name, email, phone and addresses.
 * 6. A deleted record is one removed from its array: `null` by id and in `nodes`.
 */
export interface ShopifyMockOptions {
  /** The handle; the shop is `<handle>.myshopify.com`. */
  handle?: string;
  name?: string;
  currency?: string;
  clientId?: string;
  clientSecret?: string;
  /** The scopes the app was given; `read_products,read_orders` by default. */
  scopes?: readonly string[];
  products?: MockProduct[];
  orders?: MockOrder[];
  /** What answers at an address with no shop: Shopify's "unavailable" page. */
  noShop?: boolean;
  /** Shopify refusing the grant for this shop, as it does for an app of another organization. */
  shopNotPermitted?: boolean;
  /** False: the app lacks protected customer data access, so every order query is `ACCESS_DENIED`. */
  protectedCustomerData?: boolean;
  /** Answer the first N GraphQL calls THROTTLED. */
  throttleFirst?: number;
  tokenLifetimeS?: number;
  /** The mock's clock, for the 60-day window and token expiry. */
  now?: () => number;
}

interface MockResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
}

const respond = (status: number, body: unknown, headers: Record<string, string> = {}): MockResponse => {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
  };
};

const gqlError = (message: string, code: string, extensions: Record<string, unknown> = {}): MockResponse =>
  respond(200, { errors: [{ message, extensions: { code } }], extensions });

const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;
const FILTER = /^updated_at:>='([^']+)'$/;

/** A keyset cursor over (updatedAt, id), as Shopify's encodes its sort key. */
const cursorOf = (row: { updatedAt: string; id: string }): string => `${row.updatedAt}|${row.id}`;
const numeric = (gid: string): number => Number(gid.split('/').pop());

export class ShopifyMock {
  readonly products: MockProduct[];
  readonly orders: MockOrder[];
  /** Every request's path and GraphQL operation — never its headers or body. */
  readonly requests: string[] = [];
  /** Tokens minted, in order. */
  readonly minted: string[] = [];
  private readonly options: ShopifyMockOptions;
  private readonly tokens = new Map<string, number>();
  private throttled = 0;

  constructor(options: ShopifyMockOptions = {}) {
    this.options = options;
    this.products = options.products ?? [];
    this.orders = options.orders ?? [];
  }

  get shop(): string {
    return `${this.options.handle ?? 'acme'}.myshopify.com`;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private scopes(): readonly string[] {
    return this.options.scopes ?? ['read_products', 'read_orders'];
  }

  /** The secret a connection to this shop holds. */
  get secret(): Record<string, string> {
    return { shop: this.shop, clientId: this.options.clientId ?? 'client-id', clientSecret: this.options.clientSecret ?? 'shpss_secret' };
  }

  /** Revoke every token minted so far, as Shopify may before their expiry. */
  revokeTokens(): void {
    this.tokens.clear();
  }

  get fetch(): FetchLike {
    return (async (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
      this.answer(input, init?.method ?? 'GET', init?.headers ?? {}, init?.body ?? '')) as unknown as FetchLike;
  }

  private answer(input: string, method: string, headers: Record<string, string>, body: string): MockResponse {
    const origin = `https://${this.shop}`;
    if (!input.startsWith(`${origin}/`)) throw new TypeError(`fetch failed: getaddrinfo ENOTFOUND (${input.slice(0, 40)})`);
    const path = input.slice(origin.length);
    if (this.options.noShop) {
      this.requests.push(path);
      return respond(404, '<!doctype html><title>Sorry, this store is currently unavailable.</title>', { 'Content-Type': 'text/html' });
    }
    if (path === '/admin/oauth/access_token' && method === 'POST') {
      this.requests.push(path);
      return this.mint(body);
    }
    if (path === `/admin/api/${SHOPIFY_API_VERSION}/graphql.json` && method === 'POST') {
      const request = JSON.parse(body) as { operationName?: string; query?: string; variables?: Record<string, unknown> };
      this.requests.push(`graphql ${request.operationName ?? '?'}`);
      const token = headers['X-Shopify-Access-Token'];
      const expires = token === undefined ? undefined : this.tokens.get(token);
      if (expires === undefined || expires <= this.now()) return respond(401, { errors: '[API] Invalid API key or access token (unrecognized login or wrong password)' });
      if (this.throttled < (this.options.throttleFirst ?? 0)) {
        this.throttled += 1;
        return gqlError('Throttled', 'THROTTLED', { cost: { requestedQueryCost: 500, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 100, restoreRate: 100 } } });
      }
      return this.graphql(request.operationName ?? '', request.variables ?? {});
    }
    this.requests.push(path);
    return respond(404, { errors: 'Not Found' });
  }

  private mint(body: string): MockResponse {
    const fields = Object.fromEntries(body.split('&').map((kv) => kv.split('=').map(decodeURIComponent) as [string, string]));
    if (fields.grant_type !== 'client_credentials') return respond(400, { error: 'unsupported_grant_type' });
    const { clientId, clientSecret } = this.secret;
    if (fields.client_id !== clientId || fields.client_secret !== clientSecret) {
      return respond(400, { error: 'invalid_client', error_description: 'Client authentication failed.' });
    }
    if (this.options.shopNotPermitted) return respond(400, { error: 'shop_not_permitted', error_description: 'Client credentials cannot be performed on this shop.' });
    const token = `shpat_mock_${this.minted.length + 1}`;
    const lifetime = this.options.tokenLifetimeS ?? 86399;
    this.tokens.set(token, this.now() + lifetime * 1000);
    this.minted.push(token);
    return respond(200, { access_token: token, scope: this.scopes().join(','), expires_in: lifetime });
  }

  /** Orders the app can see: all of them with `read_all_orders`, else the last 60 days'. */
  private visibleOrders(): MockOrder[] {
    if (this.scopes().includes('read_all_orders')) return this.orders;
    return this.orders.filter((o) => Date.parse(o.createdAt) >= this.now() - SIXTY_DAYS_MS);
  }

  private product(p: MockProduct): Record<string, unknown> {
    return { ...p, variants: this.nested(p.variants, SHOPIFY_NESTED_PAGE, null) };
  }

  private order(o: MockOrder, customers: boolean): Record<string, unknown> {
    const { customer, ...rest } = o;
    return { ...rest, ...(customers ? { customer: customer ?? null } : {}), lineItems: this.nested(o.lineItems, SHOPIFY_NESTED_PAGE, null) };
  }

  /** A nested connection page, its cursor the index of the last row served. */
  private nested(rows: Record<string, unknown>[], first: number, after: unknown): { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } {
    const start = typeof after === 'string' ? Number(after) + 1 : 0;
    const nodes = rows.slice(start, start + first);
    return { nodes, pageInfo: { hasNextPage: start + first < rows.length, endCursor: nodes.length === 0 ? null : String(start + nodes.length - 1) } };
  }

  private graphql(operation: string, v: Record<string, unknown>): MockResponse {
    const first = Number(v.first ?? 0);
    if (first > 250) return gqlError('The first argument must be at most 250', 'BAD_REQUEST');
    if (operation.includes('Order') && typeof v.customers !== 'boolean' && operation !== 'MoreLineItems') {
      return gqlError('Variable $customers of type Boolean! was provided invalid value', 'BAD_REQUEST');
    }
    if (this.options.protectedCustomerData === false && ['ChangedOrders', 'Order'].includes(operation)) {
      return gqlError('This app is not approved to access the Order object. See https://shopify.dev/docs/apps/launch/protected-customer-data for more details.', 'ACCESS_DENIED');
    }
    if (v.customers === true && !this.scopes().includes('read_customers')) {
      return gqlError('Access denied for customer field. Required access: `read_customers` access scope.', 'ACCESS_DENIED');
    }
    switch (operation) {
      case 'ShopInfo':
        return respond(200, {
          data: {
            shop: { id: 'gid://shopify/Shop/9001', name: this.options.name ?? 'Acme', myshopifyDomain: this.shop, currencyCode: this.options.currency ?? 'SEK', primaryDomain: { url: 'https://shop.acme.example' } },
            currentAppInstallation: { accessScopes: this.scopes().map((handle) => ({ handle })) },
          },
        });
      case 'ChangedProducts':
      case 'ChangedOrders': {
        const products = operation === 'ChangedProducts';
        let from: string | null = null;
        if (v.query !== null && v.query !== undefined) {
          const m = FILTER.exec(String(v.query));
          if (!m) return gqlError(`this mock answers only updated_at:>='…', not '${String(v.query)}'`, 'BAD_REQUEST');
          from = new Date(m[1]!).toISOString();
        }
        const rows = (products ? this.products : this.visibleOrders()) as (MockProduct | MockOrder)[];
        const key = (r: { updatedAt: string; id: string }): [number, number] => [Date.parse(r.updatedAt), numeric(r.id)];
        const sorted = rows
          .filter((r) => from === null || Date.parse(r.updatedAt) >= Date.parse(from))
          .sort((a, b) => key(a)[0] - key(b)[0] || key(a)[1] - key(b)[1]);
        let start = 0;
        if (typeof v.after === 'string') {
          const [at, id] = v.after.split('|');
          const after: [number, number] = [Date.parse(at!), numeric(id!)];
          start = sorted.findIndex((r) => key(r)[0] > after[0] || (key(r)[0] === after[0] && key(r)[1] > after[1]));
          if (start < 0) start = sorted.length;
        }
        const pageRows = sorted.slice(start, start + first);
        const nodes = pageRows.map((r) => (products ? this.product(r as MockProduct) : this.order(r as MockOrder, v.customers === true)));
        const pageInfo = { hasNextPage: start + first < sorted.length, endCursor: pageRows.length === 0 ? null : cursorOf(pageRows.at(-1)!) };
        return respond(200, { data: { [products ? 'products' : 'orders']: { nodes, pageInfo } } });
      }
      case 'Product': {
        const p = this.products.find((r) => r.id === v.id);
        return respond(200, { data: { product: p ? this.product(p) : null } });
      }
      case 'Order': {
        const o = this.visibleOrders().find((r) => r.id === v.id);
        return respond(200, { data: { order: o ? this.order(o, v.customers === true) : null } });
      }
      case 'MoreVariants': {
        const p = this.products.find((r) => r.id === v.id);
        return respond(200, { data: { product: p ? { variants: this.nested(p.variants, 100, v.after) } : null } });
      }
      case 'MoreLineItems': {
        const o = this.visibleOrders().find((r) => r.id === v.id);
        return respond(200, { data: { order: o ? { lineItems: this.nested(o.lineItems, 100, v.after) } : null } });
      }
      case 'Present': {
        const ids = (v.ids as string[]) ?? [];
        if (ids.length > 250) return gqlError('nodes takes at most 250 ids', 'BAD_REQUEST');
        const all = [...this.products, ...this.visibleOrders()];
        return respond(200, { data: { nodes: ids.map((id) => (all.some((r) => r.id === id) ? { id } : null)) } });
      }
      default:
        return gqlError(`this mock does not answer '${operation}'`, 'BAD_REQUEST');
    }
  }
}
