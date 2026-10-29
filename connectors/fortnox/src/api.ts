import { z } from 'zod';
import type { ConnectorConnection } from '@substrat-run/kernel';
import { decodeSie } from './sie4.js';

// Web-standard everywhere this runs (Node, Workers); declared locally so the
// connector pulls in no platform typings, exactly as `connector-scrive` does.
declare const TextDecoder: new (label?: string) => { decode(input: ArrayBuffer | Uint8Array): string };
declare const btoa: (data: string) => string;
// The default `sleep` only: web-standard in Node, Workers and browsers alike. Tests inject their own.
declare const setTimeout: (handler: () => void, timeout: number) => unknown;
declare const URL: new (input: string) => { searchParams: { set(k: string, v: string): void }; toString(): string };

/**
 * A thin, typed client over the Fortnox REST API and its OAuth2 token endpoint.
 *
 * Every call goes through the connection's `fetch`, never a global one: that is what
 * gets it a timeout, an egress policy, and health recorded against the right
 * connection. Module code cannot reach any of this — boundary-lint bans `fetch`
 * outright — and a connector is host code.
 *
 * ## The two hosts are different, and mixing them is the first mistake
 *
 * OAuth lives at `apps.fortnox.se/oauth-v1`; the API lives at `api.fortnox.se/3`.
 * They are separate origins with separate paths, so both are named here and neither
 * is derived from the other.
 */

/** The OAuth2 host — `/auth` (consent) and `/token` (minting) hang off this. */
export const FORTNOX_OAUTH_BASE = 'https://apps.fortnox.se/oauth-v1';
/** The REST host — every data read hangs off this. */
export const FORTNOX_API_BASE = 'https://api.fortnox.se/3';

/**
 * A Fortnox connection's credential — the CLIENT-CREDENTIALS triple.
 *
 * Deliberately NOT the authorization-code flow's tokens. Fortnox supports
 * `grant_type=client_credentials` for a *service* consent, and that changes what a
 * connection has to store: an access token is minted on demand from these three
 * static values and lives one hour, so there is no refresh token — and therefore
 * none of the rotation hazard the authorization-code flow carries. Fortnox's refresh
 * tokens are single-use and rotating: two concurrent refreshes kill the connection,
 * one winning and the other saving an already-dead token. A connector that mints
 * from static credentials cannot reach that state at all.
 *
 * The price is a one-time consent round per company, in a browser, with
 * `account_type=service` — see {@link fortnoxConsentUrl}. What that round yields is
 * the `tenantId` below; the client pair comes from the Developer Portal and is the
 * same for every company this integration serves.
 */
export const fortnoxSecret = z.object({
  /** From the Fortnox Developer Portal — the integration's identity. */
  clientId: z.string().min(1),
  /** From the Developer Portal — write-only, sealed by the host's SecretBox. */
  clientSecret: z.string().min(1),
  /**
   * WHICH Fortnox company this connection reads, as the `TenantId` header.
   *
   * Numeric, and it is the company's `DatabaseNumber` — not a name, not the org
   * number, and not anything a person would recognise. It is the one part of this
   * credential that differs per company, which is what makes one client pair serve a
   * whole fleet. Held as a string because it is a header value, never arithmetic.
   */
  tenantId: z.string().regex(/^\d+$/, 'Fortnox TenantId is the numeric DatabaseNumber'),
});
export type FortnoxSecret = z.infer<typeof fortnoxSecret>;

/**
 * The consent URL a company's sysadmin visits ONCE (the PDF's step 1, with the one
 * parameter that changes everything).
 *
 * `account_type=service` is what makes the resulting consent mintable by
 * `client_credentials` afterwards. Without it the consent is bound to the person who
 * granted it, and this connector's whole credential model does not apply — you are
 * back to storing and rotating refresh tokens per company.
 *
 * `access_type=offline` is kept because the callback still exchanges a code once, to
 * discover the `DatabaseNumber` this connection will be keyed by
 * ({@link FortnoxApi.companyInformation}). After that the code path is never used
 * again.
 *
 * **Scopes cannot be widened later without a new consent round.** Ask for what the
 * integration will need, not what it needs today — this is the single most expensive
 * thing to get wrong here, because fixing it means going back to every customer.
 */
export function fortnoxConsentUrl(input: {
  clientId: string;
  redirectUri: string;
  /** e.g. `['bookkeeping', 'companyinformation', 'supplierinvoice']` — `bookkeeping` is what SIE export needs, `supplierinvoice` reads and approves supplier invoices. */
  scopes: readonly string[];
  /** Opaque round-trip value; the caller correlates its own record by it. */
  state: string;
  oauthBase?: string;
}): string {
  const url = new URL(`${input.oauthBase ?? FORTNOX_OAUTH_BASE}/auth`);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('scope', input.scopes.join(' '));
  url.searchParams.set('state', input.state);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('account_type', 'service');
  return url.toString();
}

/** One financial year, as `GET /3/financialyears` returns it. Extra fields ignored. */
export const fortnoxFinancialYear = z.object({
  Id: z.number(),
  FromDate: z.string().min(1),
  ToDate: z.string().min(1),
  AccountingMethod: z.string().optional(),
});
export type FortnoxFinancialYear = z.infer<typeof fortnoxFinancialYear>;

/**
 * The company, as `GET /3/companyinformation` returns it.
 *
 * `DatabaseNumber` is the whole reason this endpoint is called: it IS the `TenantId`
 * header value, and it is how a connect flow learns which company the consent it just
 * received belongs to. It is also the cheapest authenticated read Fortnox offers, so
 * it doubles as the credential probe.
 */
/**
 * A text field Fortnox may send as an explicit `null`.
 *
 * `.optional()` is not enough, and the difference cost a live failure: it permits an
 * ABSENT key, while Fortnox sends the key with `null` in it for anything the company
 * has not filled in. A sandbox with a blank address answers `CountryCode: null`,
 * `ZipCode: null`, `VisitAddress: null` — verified against api.fortnox.se 2026-09-03 —
 * and the parse threw where the mock, which always sent complete strings, had passed.
 * That is exactly the seam the live suite exists to hold: the mock is our reading of
 * the docs on both sides of the call, so only a real company can disagree with it.
 *
 * Null and absent both mean "not set here", so both become the fallback.
 */
const fortnoxText = (fallback = '') =>
  z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => v ?? fallback);

export const fortnoxCompany = z.object({
  CompanyName: fortnoxText(),
  OrganizationNumber: fortnoxText(),
  // Normalized to `undefined` rather than kept as `null`, because every caller asks
  // `=== undefined` before stringifying it — and `String(null)` is the tenant id
  // `"null"`, which would key a connection to a company that does not exist.
  DatabaseNumber: z
    .union([z.number(), z.string(), z.null()])
    .optional()
    .transform((v) => v ?? undefined),
  CountryCode: fortnoxText(),
});
export type FortnoxCompany = z.infer<typeof fortnoxCompany>;

/** A number Fortnox may send as a JSON number or as a string. Kept as a string: never arithmetic on floats. */
const fortnoxNumber = z.union([z.number(), z.string().min(1)]).transform(String);

/**
 * One supplier invoice, as `GET /3/supplierinvoices/{GivenNumber}` returns it. Only the fields
 * the invoice landing carries are read; the rest are ignored.
 */
const fortnoxSupplierInvoice = z.object({
  /** Fortnox's own sequence number for the invoice in this company — the key a landing upserts by. */
  GivenNumber: fortnoxNumber,
  SupplierNumber: fortnoxText(),
  SupplierName: fortnoxText(),
  InvoiceNumber: fortnoxText(),
  InvoiceDate: fortnoxText(),
  DueDate: fortnoxText(),
  Currency: fortnoxText('SEK'),
  Total: fortnoxNumber,
  Booked: z.boolean(),
  Cancelled: z.boolean(),
  SupplierInvoiceRows: z
    .array(
      z.object({
        Account: fortnoxNumber,
        CostCenter: fortnoxText(),
        Debit: fortnoxNumber.default('0'),
        Credit: fortnoxNumber.default('0'),
      }),
    )
    .default([]),
});
export type FortnoxSupplierInvoice = z.infer<typeof fortnoxSupplierInvoice>;

/** How many list entries one `GET /3/supplierinvoices` page asks for — Fortnox's maximum. */
const LIST_LIMIT = 500;

/**
 * Fortnox's documented REST limit: 25 requests per 5 seconds per client and company (the
 * "300 a minute" figure is this, averaged). A sliding window rather than a fixed spacing, so a
 * short pass goes out at once and only a long burst waits.
 */
const RATE_LIMIT_REQUESTS = 25;
const RATE_LIMIT_WINDOW_MS = 5_000;
/** 429s in a row one request sits out before the pass fails on it. */
const RATE_LIMIT_RETRIES = 3;

/**
 * `Retry-After` in milliseconds: the header's seconds when Fortnox sends one, else a whole
 * window. Capped, so a provider answering an hour cannot hang a sweep.
 */
function retryAfterMs(header: string | null): number {
  const seconds = header === null || header.trim() === '' ? Number.NaN : Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return RATE_LIMIT_WINDOW_MS;
  return Math.min(seconds * 1000, RATE_LIMIT_WINDOW_MS * 3);
}

export interface FortnoxApiOptions {
  apiBase?: string;
  oauthBase?: string;
  /** Injected so a test can assert elapsed time without sleeping. */
  now?: () => number;
  /** Injected for the same reason: the throttle and the 429 retry wait through this. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * A sliding window SHARED by every client of one pass. The limit is per company, and a
   * sweep builds one client per binding, so a shared window is what models it.
   */
  rateWindow?: number[];
}

const tokenResponse = z.object({
  access_token: z.string().min(1),
  token_type: z.string().default('bearer'),
  expires_in: z.number().default(3600),
  scope: z.string().default(''),
});

/**
 * A Fortnox API failure, with the one bit a caller actually branches on.
 *
 * `refused` means the provider said "not with these credentials" — a 401 or 403.
 * Everything else (a timeout, a 5xx, a parse failure) says nothing about the
 * credential, and treating it as a refusal would make a Fortnox outage look like
 * every tenant's keys going bad at once.
 */
export class FortnoxApiError extends Error {
  readonly status: number;
  readonly refused: boolean;
  readonly body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'FortnoxApiError';
    this.status = status;
    this.refused = status === 401 || status === 403;
    this.body = body;
  }
}

/**
 * Fortnox's error envelope. Two shapes in the wild, and a caller wants the message
 * from whichever arrived rather than a bare status.
 */
function errorMessage(body: string, status: number): string {
  try {
    const parsed: unknown = JSON.parse(body);
    const e = parsed as {
      ErrorInformation?: { message?: string; Message?: string; error?: string };
      error_description?: string;
      error?: string;
      message?: string;
    };
    const found =
      e.ErrorInformation?.message ??
      e.ErrorInformation?.Message ??
      e.error_description ??
      e.message ??
      (typeof e.error === 'string' ? e.error : undefined);
    if (found) return found;
  } catch {
    // Not JSON — fall through to the raw slice, which is more use than nothing.
  }
  const slice = body.trim().slice(0, 200);
  return slice === '' ? `HTTP ${status}` : slice;
}

/**
 * `JSON.parse`, but a non-JSON body stays inside this module's error contract.
 *
 * Both parse sites run AFTER `res.ok`, which is exactly when this bites: a proxy,
 * captive portal or gateway that answers `200` with an HTML page makes a bare
 * `JSON.parse` throw a `SyntaxError`, and the caller loses `status`, `body` and
 * `refused` — the three fields {@link FortnoxApiError} exists to carry, and the ones a
 * sweep reports and a probe branches on. A parse failure is a fact about the response,
 * so it is reported as one.
 */
function asJson(body: string, what: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new FortnoxApiError(`${what} was not JSON`, 502, body);
  }
}

export class FortnoxApi {
  private readonly conn: ConnectorConnection;
  private readonly apiBase: string;
  private readonly oauthBase: string;
  /**
   * The minted token and when it dies, cached for the life of THIS instance.
   *
   * Per-instance rather than per-connection-global on purpose: an instance is built
   * for one sweep pass, so the cache lives exactly as long as the work that uses it
   * and no cross-request state accumulates in a Worker's isolate. A token is an hour
   * long and a pass is seconds, so one mint serves a whole pass.
   */
  private token: { value: string; expiresAtMs: number } | null = null;

  constructor(conn: ConnectorConnection, options?: FortnoxApiOptions) {
    this.conn = conn;
    this.apiBase = options?.apiBase ?? FORTNOX_API_BASE;
    this.oauthBase = options?.oauthBase ?? FORTNOX_OAUTH_BASE;
    this.now = options?.now ?? (() => Date.now());
    this.sleep = options?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.sent = options?.rateWindow ?? [];
  }

  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** When the last {@link RATE_LIMIT_REQUESTS} REST requests went out, oldest first. */
  private readonly sent: number[];

  /** Wait, if the sliding window says the next REST request would breach Fortnox's limit. */
  private async throttle(): Promise<void> {
    const cutoff = this.now() - RATE_LIMIT_WINDOW_MS;
    while (this.sent.length > 0 && this.sent[0]! <= cutoff) this.sent.shift();
    if (this.sent.length >= RATE_LIMIT_REQUESTS) {
      // The oldest request leaving the window is the earliest moment a new one fits.
      const waitMs = this.sent[0]! + RATE_LIMIT_WINDOW_MS - this.now();
      if (waitMs > 0) await this.sleep(waitMs);
      const after = this.now() - RATE_LIMIT_WINDOW_MS;
      while (this.sent.length > 0 && this.sent[0]! <= after) this.sent.shift();
    }
    this.sent.push(this.now());
  }

  /**
   * One authenticated REST request, throttled, and waited through a 429 up to
   * {@link RATE_LIMIT_RETRIES} times. The window only sees this client's traffic: a ledger
   * connection to the same company, or the company's own integrations, spend from the same
   * limit, and the retry is what absorbs them.
   */
  private async request(path: string, accept?: string): Promise<Awaited<ReturnType<ConnectorConnection['fetch']>>> {
    for (let attempt = 0; ; attempt += 1) {
      const token = await this.accessToken();
      await this.throttle();
      const res = await this.conn.fetch(`${this.apiBase}${path}`, {
        headers: { Authorization: `Bearer ${token}`, ...(accept ? { Accept: accept } : {}) },
      });
      if (res.status !== 429 || attempt >= RATE_LIMIT_RETRIES) return res;
      await this.sleep(retryAfterMs(res.headers?.get('Retry-After') ?? null));
    }
  }

  private secret(): FortnoxSecret {
    const parsed = fortnoxSecret.safeParse(this.conn.secret);
    if (!parsed.success) {
      throw new FortnoxApiError(
        `incomplete Fortnox credential: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
        400,
        '',
      );
    }
    return parsed.data;
  }

  /**
   * Mint (or reuse) an access token via `grant_type=client_credentials`.
   *
   * The 60-second skew is the PDF's, and it is right for a different reason here:
   * there is no refresh token to lose, so an early re-mint costs one extra round trip
   * rather than risking a rotation race. Cheap insurance against a token expiring
   * mid-pass.
   */
  async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAtMs - this.now() > 60_000) return this.token.value;
    const { clientId, clientSecret, tenantId } = this.secret();
    const res = await this.conn.fetch(`${this.oauthBase}/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        // The company. Without it Fortnox cannot tell which consent to mint against,
        // and answers 400 — which reads like a bad client pair and is not.
        TenantId: tenantId,
      },
      body: 'grant_type=client_credentials',
    });
    const body = await res.text();
    if (!res.ok) {
      throw new FortnoxApiError(
        `Fortnox token mint failed: ${errorMessage(body, res.status)}`,
        res.status,
        body,
      );
    }
    const parsed = tokenResponse.safeParse(asJson(body, 'Fortnox token response'));
    if (!parsed.success) {
      throw new FortnoxApiError('Fortnox token response was not the documented shape', 502, body);
    }
    this.token = {
      value: parsed.data.access_token,
      expiresAtMs: this.now() + parsed.data.expires_in * 1000,
    };
    return this.token.value;
  }

  /** A JSON GET against the REST host, authenticated with a freshly-ensured token. */
  private async getJson(path: string): Promise<unknown> {
    const res = await this.request(path, 'application/json');
    const body = await res.text();
    if (!res.ok) {
      throw new FortnoxApiError(
        `Fortnox GET ${path} failed: ${errorMessage(body, res.status)}`,
        res.status,
        body,
      );
    }
    return asJson(body, `Fortnox GET ${path}`);
  }

  /** The company — the probe read, and where a connect flow learns `DatabaseNumber`. */
  async companyInformation(): Promise<FortnoxCompany> {
    const raw = (await this.getJson('/companyinformation')) as {
      CompanyInformation?: unknown;
    };
    return fortnoxCompany.parse(raw.CompanyInformation ?? raw);
  }

  /** Every financial year the company has, newest first is NOT guaranteed — sort yourself. */
  async financialYears(): Promise<FortnoxFinancialYear[]> {
    const raw = (await this.getJson('/financialyears')) as { FinancialYears?: unknown };
    return z.array(fortnoxFinancialYear).parse(raw.FinancialYears ?? []);
  }

  /**
   * The `GivenNumber` of every supplier invoice changed at or after `lastModified` — Fortnox's
   * `YYYY-MM-DD HH:MM`, in Swedish local time. Every list page is read: the list carries no rows,
   * so it is the cheap half, and the caller decides how many details to spend.
   */
  async supplierInvoicesModifiedSince(lastModified: string): Promise<string[]> {
    const page = z.object({
      MetaInformation: z.object({ '@TotalPages': z.number() }).optional(),
      SupplierInvoices: z.array(z.object({ GivenNumber: fortnoxNumber })).default([]),
    });
    const numbers: string[] = [];
    for (let current = 1, total = 1; current <= total; current += 1) {
      const query = `lastmodified=${encodeURIComponent(lastModified)}&limit=${LIST_LIMIT}&page=${current}`;
      const parsed = page.parse(await this.getJson(`/supplierinvoices?${query}`));
      numbers.push(...parsed.SupplierInvoices.map((i) => i.GivenNumber));
      total = parsed.MetaInformation?.['@TotalPages'] ?? 1;
    }
    return numbers;
  }

  /** One supplier invoice with its rows. */
  async supplierInvoice(givenNumber: string): Promise<FortnoxSupplierInvoice> {
    const raw = (await this.getJson(`/supplierinvoices/${encodeURIComponent(givenNumber)}`)) as {
      SupplierInvoice?: unknown;
    };
    return fortnoxSupplierInvoice.parse(raw.SupplierInvoice ?? raw);
  }

  /**
   * The whole year's bookkeeping as one SIE4 file — the read this connector exists for.
   *
   * **The response is PC8 (code page 437), not UTF-8 and not latin1**, and nothing in
   * the HTTP response says so — only the file's own `#FORMAT` post does. Decoding it
   * wrong mangles every å/ä/ö in every account name, cost-centre label and verification
   * text, which is a corrupted ledger that looks like a working one. Decoding as latin1
   * does not even fail loudly: every byte is a valid latin1 code point, so it produces
   * no replacement character and no throw. That is what shipped here until a live call
   * disproved it. So the bytes are taken as an ArrayBuffer and handed to `decodeSie`,
   * which owns the charset decision for the whole connector.
   */
  async sieFile(financialYearId: number): Promise<string> {
    const res = await this.request(`/sie/4?financialyear=${financialYearId}`);
    if (!res.ok) {
      const body = await res.text();
      throw new FortnoxApiError(
        `Fortnox SIE4 export failed: ${errorMessage(body, res.status)}`,
        res.status,
        body,
      );
    }
    // PC8/CP437, not latin1 — see `decodeSie`. Fortnox declares it in `#FORMAT`.
    return decodeSie(await res.arrayBuffer());
  }
}
