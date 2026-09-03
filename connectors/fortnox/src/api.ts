import { z } from 'zod';
import type { ConnectorConnection } from '@substrat-run/kernel';

// Web-standard everywhere this runs (Node, Workers); declared locally so the
// connector pulls in no platform typings, exactly as `connector-scrive` does.
declare const TextDecoder: new (label?: string) => { decode(input: ArrayBuffer | Uint8Array): string };
declare const btoa: (data: string) => string;
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
  /** e.g. `['bookkeeping', 'companyinformation']` — `bookkeeping` is what SIE export needs. */
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
export const fortnoxCompany = z.object({
  CompanyName: z.string().default(''),
  OrganizationNumber: z.string().default(''),
  DatabaseNumber: z.union([z.number(), z.string()]).optional(),
  CountryCode: z.string().optional(),
});
export type FortnoxCompany = z.infer<typeof fortnoxCompany>;

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

  constructor(
    conn: ConnectorConnection,
    options?: { apiBase?: string; oauthBase?: string; now?: () => number },
  ) {
    this.conn = conn;
    this.apiBase = options?.apiBase ?? FORTNOX_API_BASE;
    this.oauthBase = options?.oauthBase ?? FORTNOX_OAUTH_BASE;
    this.now = options?.now ?? (() => Date.now());
  }

  private readonly now: () => number;

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
    const token = await this.accessToken();
    const res = await this.conn.fetch(`${this.apiBase}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
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
   * The whole year's bookkeeping as one SIE4 file — the read this connector exists for.
   *
   * **The response is ISO-8859-1, not UTF-8**, and nothing in the response says so.
   * Decoding it as UTF-8 does not throw; it silently mangles every å/ä/ö in every
   * account name, cost-centre label and verification text — which is a corrupted
   * ledger that looks like a working one. So the bytes are taken as an ArrayBuffer and
   * decoded explicitly, and this is the only place in the connector that knows.
   */
  async sieFile(financialYearId: number): Promise<string> {
    const token = await this.accessToken();
    const path = `/sie/4?financialyear=${financialYearId}`;
    const res = await this.conn.fetch(`${this.apiBase}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new FortnoxApiError(
        `Fortnox SIE4 export failed: ${errorMessage(body, res.status)}`,
        res.status,
        body,
      );
    }
    return new TextDecoder('iso-8859-1').decode(await res.arrayBuffer());
  }
}
