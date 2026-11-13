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
 * A WooCommerce store in memory — the reads the connector makes, enough to run the probe and the
 * whole inbound sync without a store.
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
 */
export interface WooCommerceMockOptions {
  storeUrl?: string;
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
  /** Answer the first N authenticated requests with 429. */
  rateLimitFirst?: number;
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
  /** Every request's path and query — never its headers. */
  readonly requests: string[] = [];
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
    return (async (input: string, init?: { headers?: Record<string, string> }) => this.answer(input, init?.headers ?? {})) as unknown as FetchLike;
  }

  private answer(input: string, headers: Record<string, string>): MockResponse {
    if (!input.startsWith(this.storeUrl)) throw new TypeError(`fetch failed: getaddrinfo ENOTFOUND (${input.slice(0, 40)})`);
    const url = new URL(input);
    const path = input.slice(this.storeUrl.length);
    this.requests.push(path);
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

    if (route === '/system_status') {
      if (this.options.manager === false) return wcError(403, 'woocommerce_rest_cannot_view', 'Sorry, you cannot list resources.');
      const fields = (url.searchParams.get('_fields') ?? '').split(',');
      if (fields.includes('environment') || fields.includes('')) this.remoteTests += 1;
      return respond(200, {
        environment: { site_url: this.storeUrl, home_url: this.storeUrl, version: this.options.version ?? '9.4.0', store_id: null },
        settings: { currency: this.options.currency ?? 'SEK' },
      });
    }
    const variations = /^\/products\/(\d+)\/variations$/.exec(route);
    if (variations) return this.page(this.variations[Number(variations[1])] ?? [], url);
    if (route === '/products' || route === '/orders') {
      return this.changed(route === '/products' ? this.products : this.orders, url);
    }
    return wcError(404, 'rest_no_route', 'No route was found matching the URL and request method.');
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
