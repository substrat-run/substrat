import { z } from 'zod';
import type { ConnectorConnection } from '@substrat-run/kernel';
import { storeBaseUrl } from './store-url.js';

// Web-standard everywhere this runs (Node, Workers); declared locally so the
// connector pulls in no platform typings, exactly as `connector-planima` does.
declare const URL: new (input: string) => {
  searchParams: { set(k: string, v: string): void };
  toString(): string;
};
declare const btoa: (data: string) => string;
// The default `sleep` only. Every caller inside the platform injects its own, and a test always does.
declare const setTimeout: (handler: () => void, timeout: number) => unknown;

/**
 * A thin, typed client over the WooCommerce REST API (`wc/v3`). Every call goes through the
 * connection's `fetch`, never a global one: that is what gets it a timeout, an egress policy, and
 * health recorded against the right connection.
 *
 * ## Authentication, and the one way it must not be sent
 *
 * Over HTTPS WooCommerce takes the consumer key and secret as HTTP Basic credentials. It also
 * accepts them as `consumer_key`/`consumer_secret` query parameters, and this client never does
 * that: a query string is written to access logs, proxies and error messages, and the secret would
 * go with it. Over plain HTTP WooCommerce wants OAuth 1.0a signatures instead, which is one reason
 * the store URL must be `https:` ({@link storeBaseUrl}).
 *
 * ## Paging
 *
 * A list answers a bare JSON array, at most 100 rows a page (`per_page`), with the page count in
 * `X-WP-TotalPages`. A `200` whose body is not an array is a fault, never an empty list.
 */
export const WOOCOMMERCE_API_PATH = '/wp-json/wc/v3';
/** WooCommerce's page ceiling; asking for more is refused as an invalid parameter. */
export const WOOCOMMERCE_MAX_PAGE = 100;

/**
 * A WooCommerce connection's credential: where the store is, and a REST API key made in
 * WooCommerce → Settings → Advanced → REST API. The key needs **Read** permission and must belong
 * to an administrator or a shop manager: the probe reads the store's own settings, which
 * WooCommerce shows to those two roles only. Both halves are printable ASCII (`ck_…`, `cs_…`).
 */
export const woocommerceSecret = z.object({
  storeUrl: z.string().min(1),
  consumerKey: z.string().regex(/^[\x21-\x7e]+$/, 'printable ASCII only'),
  consumerSecret: z.string().regex(/^[\x21-\x7e]+$/, 'printable ASCII only'),
});
export type WooCommerceSecret = z.infer<typeof woocommerceSecret>;

/**
 * A WooCommerce API failure, with what a caller branches on.
 *
 * - `refused`: the store said "not with this key" (401 or 403).
 * - `notStore`: there is no WooCommerce REST API at that address — a 404, a page that is not JSON,
 *   or JSON that is not WooCommerce's index. Says nothing about the key.
 *
 * Everything else (a timeout, a 5xx) says nothing about either. The message carries WooCommerce's
 * own `message` and `code`, never the request's headers, and the request's URL never carries the
 * key, so no message here can carry credential material.
 */
export class WooCommerceApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly refused: boolean;
  readonly notStore: boolean;
  constructor(message: string, status: number, code: string | null = null, notStore = false) {
    super(message);
    this.name = 'WooCommerceApiError';
    this.status = status;
    this.code = code;
    this.refused = status === 401 || status === 403;
    this.notStore = notStore;
  }
}

/** WooCommerce's error body is `{ code, message, data: { status } }`. */
function errorOf(body: string, status: number): { message: string; code: string | null } {
  try {
    const e = JSON.parse(body) as { code?: unknown; message?: unknown };
    if (typeof e.message === 'string') {
      return { message: e.message, code: typeof e.code === 'string' ? e.code : null };
    }
  } catch {
    // Not JSON: a proxy's or a theme's page. Its text is not worth quoting.
  }
  return { message: `HTTP ${status}`, code: null };
}

// Provider shapes. Extra fields are ignored. WooCommerce sends a blank as `null` or `''`, never an
// absent key, but a plugin can drop one, so every field reads absent as its blank.
const str = () => z.union([z.string(), z.null()]).optional().transform((v) => v ?? '');
const nullableStr = () => z.union([z.string(), z.null()]).optional().transform((v) => (v === undefined || v === null || v === '' ? null : v));
/** WooCommerce declares some ids "mixed": an integer on one store, a string on another. */
const looseId = () =>
  z.union([z.number(), z.string(), z.null()]).optional().transform((v) => {
    const n = typeof v === 'string' ? Number(v) : (v ?? 0);
    return Number.isInteger(n) && n > 0 ? String(n) : null;
  });

export const wcAddress = z.object({
  first_name: str(),
  last_name: str(),
  company: str(),
  address_1: str(),
  address_2: str(),
  city: str(),
  state: str(),
  postcode: str(),
  country: str(),
  email: nullableStr(),
  phone: nullableStr(),
});
export type WcAddress = z.infer<typeof wcAddress>;

export const wcProduct = z.object({
  id: z.number().int(),
  name: str(),
  slug: nullableStr(),
  permalink: nullableStr(),
  /** `simple`, `variable`, `grouped`, `external`, or a plugin's own. Only `variable` is read for variations. */
  type: str(),
  status: str(),
  sku: nullableStr(),
  /** Money as WooCommerce sends it: a decimal string, `''` when no price is set. */
  price: str(),
  regular_price: str(),
  date_created_gmt: nullableStr(),
  date_modified_gmt: nullableStr(),
});
export type WcProduct = z.infer<typeof wcProduct>;

export const wcVariation = z.object({
  id: z.number().int(),
  sku: nullableStr(),
  price: str(),
  regular_price: str(),
  /** One `option` per attribute — not the product's `options` array. */
  attributes: z.array(z.object({ name: str(), option: str() })).optional().transform((v) => v ?? []),
});
export type WcVariation = z.infer<typeof wcVariation>;

export const wcOrder = z.object({
  id: z.number().int(),
  number: nullableStr(),
  status: str(),
  currency: str(),
  /** Money fields are strings. `line_items[].price` is a NUMBER, and is never read. */
  total: str(),
  total_tax: str(),
  shipping_total: str(),
  discount_total: str(),
  customer_id: z.number().int().nullable().optional().transform((v) => v ?? 0),
  customer_note: nullableStr(),
  billing: wcAddress.nullable().optional().transform((v) => v ?? null),
  shipping: wcAddress.nullable().optional().transform((v) => v ?? null),
  date_created_gmt: nullableStr(),
  date_modified_gmt: nullableStr(),
  date_paid_gmt: nullableStr(),
  line_items: z
    .array(
      z.object({
        id: z.number().int(),
        name: z.union([z.string(), z.number(), z.null()]).optional().transform((v) => (v === undefined || v === null ? '' : String(v))),
        product_id: looseId(),
        variation_id: looseId(),
        quantity: z.number(),
        sku: nullableStr(),
        subtotal: str(),
        total: str(),
        total_tax: str(),
      }),
    )
    .optional()
    .transform((v) => v ?? []),
});
export type WcOrder = z.infer<typeof wcOrder>;

/**
 * What the probe and the sync read of the store itself, from `system_status`.
 *
 * Narrowed with NESTED `_fields` names on purpose. Asked for the bare `environment` section,
 * WooCommerce runs two remote tests on every call (a POST to PayPal and a GET to woocommerce.com);
 * asked for `environment.site_url`, it builds the section without them. `settings.currency` is
 * the store's currency, which a product does not state. Read leniently: a store that ignores
 * `_fields` answers the whole report, and the parse keeps the four leaves.
 */
export const wcStoreInfo = z.object({
  environment: z.object({
    site_url: str(),
    home_url: str(),
    version: str(),
  }),
  settings: z.object({ currency: str() }),
});
export type WcStoreInfo = z.infer<typeof wcStoreInfo>;
const STORE_INFO_FIELDS = 'environment.site_url,environment.home_url,environment.version,settings.currency';

export interface WooCommerceApiOptions {
  /** Injected so a test can wait through a 429 without sleeping. */
  sleep?: (ms: number) => Promise<void>;
  /** How many 429s in a row a request sits out. Zero disables the retry, which is what a probe wants. */
  maxRateLimitRetries?: number;
  /** For the live test's local store only: admit `http://localhost`. Never set by the platform. */
  allowLocalHttp?: boolean;
}

/** A 429 with no usable `Retry-After` waits this long; a longer one is capped at three times it. */
const DEFAULT_RETRY_MS = 10_000;

export class WooCommerceApi {
  private readonly conn: ConnectorConnection;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRateLimitRetries: number;
  private readonly allowLocalHttp: boolean;

  constructor(conn: ConnectorConnection, options?: WooCommerceApiOptions) {
    this.conn = conn;
    this.sleep = options?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRateLimitRetries = options?.maxRateLimitRetries ?? 3;
    this.allowLocalHttp = options?.allowLocalHttp ?? false;
  }

  private secret(): WooCommerceSecret {
    const parsed = woocommerceSecret.safeParse(this.conn.secret);
    if (!parsed.success) {
      // Names the fields, never their values.
      throw new WooCommerceApiError(
        `incomplete WooCommerce credential: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
        400,
      );
    }
    return parsed.data;
  }

  /** The REST base this credential's store is read at, after {@link storeBaseUrl} has judged it. */
  base(): string {
    return `${storeBaseUrl(this.secret().storeUrl, { allowLocalHttp: this.allowLocalHttp })}${WOOCOMMERCE_API_PATH}`;
  }

  private async get(path: string, authenticated: boolean): Promise<{ json: unknown; totalPages: number | null }> {
    const url = `${this.base()}${path}`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (authenticated) {
      const { consumerKey, consumerSecret } = this.secret();
      headers.Authorization = `Basic ${btoa(`${consumerKey}:${consumerSecret}`)}`;
    }
    for (let attempt = 0; ; attempt += 1) {
      const res = await this.conn.fetch(url, { headers });
      const body = await res.text();
      if (res.ok) {
        let json: unknown;
        try {
          json = JSON.parse(body);
        } catch {
          // A 200 that is not JSON is a page, not an API: a theme, a maintenance screen, a login wall.
          throw new WooCommerceApiError(`GET ${path || '/'} answered a page that is not JSON`, 502, null, true);
        }
        const pages = Number(res.headers?.get('X-WP-TotalPages') ?? Number.NaN);
        return { json, totalPages: Number.isFinite(pages) ? pages : null };
      }
      if (res.status === 429 && attempt < this.maxRateLimitRetries) {
        await this.sleep(retryAfterMs(res.headers?.get('Retry-After') ?? null));
        continue;
      }
      const e = errorOf(body, res.status);
      throw new WooCommerceApiError(
        `WooCommerce GET ${path || '/'} failed (${res.status}${e.code ? ` ${e.code}` : ''}): ${e.message}`,
        res.status,
        e.code,
        // No route at all: WordPress without WooCommerce, or no WordPress.
        res.status === 404 && (e.code === null || e.code === 'rest_no_route'),
      );
    }
  }

  /**
   * The unauthenticated `wc/v3` index: is there a WooCommerce REST API here at all? Answered before
   * the key is tried, so "wrong address" and "wrong key" are told apart.
   */
  async index(): Promise<void> {
    const { json } = await this.get('', false);
    const namespace = (json as { namespace?: unknown } | null)?.namespace;
    if (namespace !== 'wc/v3') {
      throw new WooCommerceApiError('the address answers JSON, but not a WooCommerce REST API (no wc/v3 namespace)', 502, null, true);
    }
  }

  /** The store's own URL, WooCommerce version and currency — see {@link wcStoreInfo}. */
  async storeInfo(): Promise<WcStoreInfo> {
    const { json } = await this.get(`/system_status?_fields=${STORE_INFO_FIELDS}`, true);
    const parsed = wcStoreInfo.safeParse(json);
    if (!parsed.success) throw new WooCommerceApiError('the store status report had no environment or settings section', 502);
    return parsed.data;
  }

  /**
   * One page of products or orders changed after `modifiedAfter` (UTC, seconds), oldest change
   * first. The sync walks these by keyset, not by page number; see `syncWooCommerceScope`.
   */
  async changedPage(
    resource: 'products' | 'orders',
    modifiedAfter: string | null,
    page: number,
  ): Promise<unknown[]> {
    const url = new URL(`https://x/${resource}`);
    url.searchParams.set('per_page', String(WOOCOMMERCE_MAX_PAGE));
    url.searchParams.set('page', String(page));
    url.searchParams.set('orderby', 'modified');
    url.searchParams.set('order', 'asc');
    url.searchParams.set('dates_are_gmt', 'true');
    if (modifiedAfter !== null) url.searchParams.set('modified_after', modifiedAfter);
    const { json } = await this.get(url.toString().slice('https://x'.length), true);
    return this.rows(json, resource);
  }

  /** Every variation of a variable product. A product's variations are few; this walks pages by number. */
  async variations(productId: number): Promise<WcVariation[]> {
    const rows: WcVariation[] = [];
    for (let page = 1; ; page += 1) {
      const path = `/products/${productId}/variations?per_page=${WOOCOMMERCE_MAX_PAGE}&page=${page}`;
      const { json, totalPages } = await this.get(path, true);
      const batch = z.array(wcVariation).parse(this.rows(json, path));
      rows.push(...batch);
      // The page count when it is sent; a short page either way, so a missing header cannot spin.
      if (batch.length < WOOCOMMERCE_MAX_PAGE || (totalPages !== null && page >= totalPages)) return rows;
    }
  }

  private rows(json: unknown, what: string): unknown[] {
    if (!Array.isArray(json)) {
      throw new WooCommerceApiError(`WooCommerce GET ${what} answered success with something other than a list`, 502);
    }
    return json;
  }
}

function retryAfterMs(header: string | null): number {
  const seconds = header === null ? Number.NaN : Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_RETRY_MS;
  // A store that answers with an hour must not become an hour-long hung sweep.
  return Math.min(seconds * 1000, DEFAULT_RETRY_MS * 3);
}
