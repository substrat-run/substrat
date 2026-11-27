import type { FetchLike } from '@substrat-run/kernel';
import { WOOCOMMERCE_API_PATH, WOOCOMMERCE_MAX_PAGE } from './api.js';

// Web-standard everywhere this runs; declared locally so the mock pulls in no platform typings.
declare const URL: new (input: string) => {
  pathname: string;
  searchParams: { get(name: string): string | null; has(name: string): boolean };
};
declare const btoa: (data: string) => string;

/** A row as WooCommerce sends it: explicit `null`s and `''`s included, so a test writes what the store does. */
export type MockRow = Record<string, unknown> & { id: number; date_modified_gmt: string | null };

/**
 * A WooCommerce store in memory — the reads and writes the connector makes, enough to run the probe,
 * the whole inbound sync and the write-back dispatch (#3136) without a store.
 *
 * **What a mock proves:** that our shape works — Basic auth, the keyset walk, the modified-since
 * filter, variations, the probe's three outcomes. **What it cannot prove:** that our reading of the
 * WooCommerce REST API is right. The mock IS our reading; `test/live.test.ts` checks it against a
 * real store when one is configured.
 *
 * Strict where a convenient mock would let a client be wrong while every test passes:
 *
 * 1. **The key must arrive as HTTP Basic.** A request carrying `consumer_key` in its query string
 *    is refused here (WooCommerce would accept it, and the secret would be in every log).
 * 2. **`per_page` over 100 is a 400**, as WooCommerce's parameter validation answers it.
 * 3. **`modified_after` can be inclusive or exclusive** (`modifiedAfterInclusive`): WooCommerce's
 *    boundary is not documented, so the sync is tested against both.
 * 4. **Asking `system_status` for the bare `environment` section counts a remote test** in
 *    `remoteTests`: the real store would call PayPal and woocommerce.com on that request.
 * 5. **The trash is out of every listing unless asked for** (`status=trash`), as WordPress's `any`
 *    leaves it out. A row is trashed by setting its `status` to `'trash'`, and deleted by removing
 *    it from the array; reading a deleted id answers WooCommerce's `…_invalid_id` 404.
 */
export interface WooCommerceMockOptions {
  storeUrl?: string;
  /** The address the store reports for itself (`home_url`); `storeUrl` by default. */
  homeUrl?: string;
  consumerKey?: string;
  consumerSecret?: string;
  currency?: string;
  version?: string;
  products?: MockRow[];
  /** A variable product's variations, by product id. */
  variations?: Record<number, Record<string, unknown>[]>;
  orders?: MockRow[];
  /** False: the key's user is no manager, so `system_status` answers `woocommerce_rest_cannot_view`. */
  manager?: boolean;
  modifiedAfterInclusive?: boolean;
  /** What answers when the address is no WooCommerce store: WordPress without it, or a plain page. */
  notWooCommerce?: 'wordpress' | 'html';
  /** A store whose plugins drop `include`: the listing answers its first page, as if not asked by id. */
  ignoreInclude?: boolean;
  /** Answer the first N authenticated requests with 429. */
  rateLimitFirst?: number;
  /** False: the key has Read permission only, so every write answers WooCommerce's 401 (#3136). */
  write?: boolean;
  /** The GMT time a write saves a record at; a write moves its modified date, as a save does. */
  writtenAt?: string;
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

const wcError = (status: number, code: string, message: string): MockResponse =>
  respond(status, { code, message, data: { status } });

export class WooCommerceMock {
  readonly storeUrl: string;
  readonly products: MockRow[];
  readonly orders: MockRow[];
  readonly variations: Record<number, Record<string, unknown>[]>;
  /** Every request's path and query — never its headers. A write is prefixed with its method. */
  readonly requests: string[] = [];
  /** Every write's path and body, in order. */
  readonly writes: { path: string; body: Record<string, unknown> }[] = [];
  remoteTests = 0;
  private readonly options: WooCommerceMockOptions;
  private rateLimited = 0;

  constructor(options: WooCommerceMockOptions = {}) {
    this.options = options;
    this.storeUrl = options.storeUrl ?? 'https://shop.example.com';
    this.products = options.products ?? [];
    this.orders = options.orders ?? [];
    this.variations = options.variations ?? {};
  }

  /** The secret a connection to this store holds. */
  get secret(): Record<string, string> {
    return {
      storeUrl: this.storeUrl,
      consumerKey: this.options.consumerKey ?? 'ck_test',
      consumerSecret: this.options.consumerSecret ?? 'cs_test',
    };
  }

  get fetch(): FetchLike {
    return (async (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
      this.answer(input, init?.headers ?? {}, init?.method ?? 'GET', init?.body)) as unknown as FetchLike;
  }

  private answer(input: string, headers: Record<string, string>, method: string, body: string | undefined): MockResponse {
    if (!input.startsWith(this.storeUrl)) throw new TypeError(`fetch failed: getaddrinfo ENOTFOUND (${input.slice(0, 40)})`);
    const url = new URL(input);
    const path = input.slice(this.storeUrl.length);
    this.requests.push(method === 'GET' ? path : `${method} ${path}`);
    if (this.options.notWooCommerce === 'html') return respond(200, '<!doctype html><title>Shop</title>', { 'Content-Type': 'text/html' });
    if (!url.pathname.startsWith(new URL(this.storeUrl).pathname.replace(/\/$/, '') + WOOCOMMERCE_API_PATH)) {
      return wcError(404, 'rest_no_route', 'No route was found matching the URL and request method.');
    }
    if (this.options.notWooCommerce === 'wordpress') return wcError(404, 'rest_no_route', 'No route was found matching the URL and request method.');
    if (url.searchParams.has('consumer_key') || url.searchParams.has('consumer_secret')) {
      return wcError(400, 'mock_key_in_query', 'this mock refuses a key in the query string');
    }
    const route = path.split('?')[0]!.slice(path.indexOf(WOOCOMMERCE_API_PATH) + WOOCOMMERCE_API_PATH.length);
    if (route === '') return respond(200, { namespace: 'wc/v3', routes: {} });

    const { consumerKey, consumerSecret } = this.secret;
    if (headers.Authorization !== `Basic ${btoa(`${consumerKey}:${consumerSecret}`)}`) {
      return wcError(401, 'woocommerce_rest_authentication_error', 'Consumer key is invalid.');
    }
    if (this.rateLimited < (this.options.rateLimitFirst ?? 0)) {
      this.rateLimited += 1;
      return respond(429, { code: 'too_many_requests', message: 'Slow down.' }, { 'Retry-After': '2' });
    }

    if (method === 'PUT') return this.write(route, path, headers, body);
    if (method !== 'GET') return wcError(404, 'rest_no_route', 'No route was found matching the URL and request method.');

    if (route === '/system_status') {
      if (this.options.manager === false) return wcError(403, 'woocommerce_rest_cannot_view', 'Sorry, you cannot list resources.');
      const fields = (url.searchParams.get('_fields') ?? '').split(',');
      if (fields.includes('environment') || fields.includes('')) this.remoteTests += 1;
      return respond(200, {
        environment: { site_url: this.storeUrl, home_url: this.options.homeUrl ?? this.storeUrl, version: this.options.version ?? '9.4.0', store_id: null },
        settings: { currency: this.options.currency ?? 'SEK' },
      });
    }
    const variations = /^\/products\/(\d+)\/variations$/.exec(route);
    if (variations) return this.page(this.variations[Number(variations[1])] ?? [], url);
    const oneVariation = /^\/products\/(\d+)\/variations\/(\d+)$/.exec(route);
    if (oneVariation) {
      const row = (this.variations[Number(oneVariation[1])] ?? []).find((r) => r.id === Number(oneVariation[2]));
      return row ? respond(200, row) : wcError(404, 'woocommerce_rest_product_variation_invalid_id', 'Invalid ID.');
    }
    const one = /^\/(products|orders)\/(\d+)$/.exec(route);
    if (one) {
      const row = (one[1] === 'products' ? this.products : this.orders).find((r) => r.id === Number(one[2]));
      if (!row) return wcError(404, `woocommerce_rest_${one[1] === 'products' ? 'product' : 'shop_order'}_invalid_id`, 'Invalid ID.');
      const fields = url.searchParams.get('_fields');
      return respond(200, fields === null ? row : Object.fromEntries(fields.split(',').map((f) => [f, row[f]])));
    }
    if (route === '/products' || route === '/orders') {
      const rows = route === '/products' ? this.products : this.orders;
      const status = url.searchParams.get('status') ?? 'any';
      const inStatus = rows.filter((r) => (status === 'any' ? r.status !== 'trash' : r.status === status));
      if (url.searchParams.has('include') && this.options.ignoreInclude) return this.page(inStatus.map((r) => ({ id: r.id })), url);
      if (url.searchParams.has('include')) {
        const ids = new Set(url.searchParams.get('include')!.split(',').map(Number));
        return this.page(inStatus.filter((r) => ids.has(r.id)).map((r) => ({ id: r.id })), url);
      }
      return this.changed(inStatus, url);
    }
    return wcError(404, 'rest_no_route', 'No route was found matching the URL and request method.');
  }

  /**
   * A write (#3136): `stock_quantity`/`manage_stock` on a product or a variation, `status` on an
   * order. Like the store, a write answers the record as it now stands and moves its modified date;
   * a stock count on a variation sharing its product's (`'parent'`) is taken as the variation's own.
   */
  private write(route: string, path: string, headers: Record<string, string>, body: string | undefined): MockResponse {
    if (headers['Content-Type'] !== 'application/json') return wcError(400, 'mock_content_type', 'this mock takes a JSON body only');
    if (this.options.write === false) return wcError(401, 'woocommerce_rest_cannot_edit', 'Sorry, you are not allowed to edit this resource.');
    const changes = JSON.parse(body ?? '{}') as Record<string, unknown>;
    this.writes.push({ path, body: changes });
    const at = this.options.writtenAt ?? '2026-11-20T12:00:00';
    const saved = { date_modified_gmt: at, date_modified: at };
    const variation = /^\/products\/(\d+)\/variations\/(\d+)$/.exec(route);
    if (variation) {
      const parent = this.products.find((r) => r.id === Number(variation[1]));
      const row = (this.variations[Number(variation[1])] ?? []).find((r) => r.id === Number(variation[2]));
      if (!parent || !row) return wcError(404, 'woocommerce_rest_product_variation_invalid_id', 'Invalid ID.');
      Object.assign(row, this.stockOf(changes));
      Object.assign(parent, saved);
      return respond(200, row);
    }
    const one = /^\/(products|orders)\/(\d+)$/.exec(route);
    const row = one ? (one[1] === 'products' ? this.products : this.orders).find((r) => r.id === Number(one[2])) : undefined;
    if (!one) return wcError(404, 'rest_no_route', 'No route was found matching the URL and request method.');
    if (!row) return wcError(404, `woocommerce_rest_${one[1] === 'products' ? 'product' : 'shop_order'}_invalid_id`, 'Invalid ID.');
    if (one[1] === 'products') {
      Object.assign(row, this.stockOf(changes), saved);
      // A product's count is what its shared variations report.
      for (const v of this.variations[row.id] ?? []) if (v.manage_stock === 'parent') v.stock_quantity = row.stock_quantity;
    } else {
      if (typeof changes.status !== 'string') return wcError(400, 'rest_invalid_param', 'Invalid parameter(s): status');
      Object.assign(row, { status: changes.status }, saved);
    }
    return respond(200, row);
  }

  private stockOf(changes: Record<string, unknown>): Record<string, unknown> {
    if (changes.stock_quantity === undefined) return {};
    const quantity = changes.stock_quantity;
    if (typeof quantity !== 'number' || !Number.isInteger(quantity)) throw new TypeError('mock: stock_quantity must be an integer');
    return {
      manage_stock: changes.manage_stock ?? true,
      stock_quantity: quantity,
      stock_status: quantity > 0 ? 'instock' : 'outofstock',
    };
  }

  private changed(rows: MockRow[], url: InstanceType<typeof URL>): MockResponse {
    const after = url.searchParams.get('modified_after');
    const inclusive = this.options.modifiedAfterInclusive ?? false;
    if (url.searchParams.get('orderby') !== 'modified' || url.searchParams.get('order') !== 'asc') {
      return wcError(400, 'mock_order', 'this mock answers changed lists oldest change first only');
    }
    // `dates_are_gmt=true` compares against the GMT column, as the sync asks it to.
    const gmt = url.searchParams.get('dates_are_gmt') === 'true';
    const key = (r: MockRow): string => String((gmt ? r.date_modified_gmt : r.date_modified) ?? '');
    const selected = rows
      .filter((r) => after === null || (inclusive ? key(r) >= after : key(r) > after))
      .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.id - b.id));
    return this.page(selected, url);
  }

  private page(rows: Record<string, unknown>[], url: InstanceType<typeof URL>): MockResponse {
    const perPage = Number(url.searchParams.get('per_page') ?? 10);
    if (!(perPage >= 1 && perPage <= WOOCOMMERCE_MAX_PAGE)) {
      return wcError(400, 'rest_invalid_param', 'Invalid parameter(s): per_page');
    }
    const page = Number(url.searchParams.get('page') ?? 1);
    const totalPages = Math.max(1, Math.ceil(rows.length / perPage));
    return respond(200, rows.slice((page - 1) * perPage, page * perPage), {
      'X-WP-Total': String(rows.length),
      'X-WP-TotalPages': String(totalPages),
    });
  }
}
