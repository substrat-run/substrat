import { resolveEndpoints, type BolagsverketConfig, type BolagsverketCredential, type BolagsverketEndpoints } from './config.js';
import { BolagsverketError, errorMessage } from './errors.js';
import { organisationResult, rawOrganisationResponse, type OrganisationValidation } from './organisation.js';
import { parseOrgnr } from './orgnr.js';
import { SlidingWindow, retryAfterMs } from './throttle.js';
import { ClientCredentialsToken, exchange, type Fetch } from './token.js';

// The default `sleep` only; every caller inside the platform, and every test, injects one.
declare const setTimeout: (handler: () => void, timeout: number) => unknown;

export interface BolagsverketApiOptions extends BolagsverketConfig {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 429s sat out before a request gives up. Zero is what a probe wants. Default 3. */
  maxRateLimitRetries?: number;
  /** A throttle window shared by every client on one credential; see `throttle.ts`. */
  rateWindow?: number[];
}

/**
 * A typed client over Bolagsverket's value-datasets API (API för värdefulla datamängder).
 *
 * It takes the credential and a `fetch` rather than a connection, so the same client
 * serves whichever credential model the platform registration settles on. In the
 * platform, `fetch` is a connection's sanctioned egress; in a test or a local run it is
 * `globalFetch` from `@substrat-run/kernel`, never the bare global (`lint:bound-fetch`).
 */
export class BolagsverketApi {
  readonly endpoints: BolagsverketEndpoints;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRateLimitRetries: number;
  private readonly window: SlidingWindow;
  private readonly token: ClientCredentialsToken;

  constructor(
    credential: BolagsverketCredential,
    private readonly fetch: Fetch,
    options: BolagsverketApiOptions = {},
  ) {
    this.endpoints = resolveEndpoints(options);
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRateLimitRetries = options.maxRateLimitRetries ?? 3;
    this.window = new SlidingWindow(this.now, this.sleep, options.rateWindow);
    this.token = new ClientCredentialsToken(credential, this.endpoints.tokenUrl, fetch, this.now);
  }

  /**
   * One authenticated, throttled request. A 401 re-mints the token once, since a cached
   * token the provider revoked early is not a refused client; a 429 waits as `Retry-After`
   * says, up to `maxRateLimitRetries` times. Answers the status and body; mapping a status
   * to an outcome is the caller's, because 404 means "no such organisation" on a lookup.
   */
  private async request(method: 'GET' | 'POST', path: string, json?: unknown): Promise<{ status: number; body: string }> {
    let reminted = false;
    for (let attempt = 0; ; attempt += 1) {
      const token = await this.token.get();
      await this.window.acquire();
      const res = await exchange(
        this.fetch,
        `${this.endpoints.apiBase}${path}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            ...(json === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(json === undefined ? {} : { body: JSON.stringify(json) }),
        },
        `Bolagsverket ${method} ${path}`,
      );
      const { body } = res;
      if (res.status === 401 && !reminted) {
        reminted = true;
        this.token.invalidate();
        continue;
      }
      if (res.status === 429) {
        const waitMs = retryAfterMs(res.retryAfter);
        if (attempt < this.maxRateLimitRetries) {
          await this.sleep(waitMs);
          continue;
        }
        throw new BolagsverketError('rate_limited', `Bolagsverket ${method} ${path} is rate-limited`, {
          status: 429,
          body,
          retryAfterSeconds: waitMs / 1000,
        });
      }
      if (res.status === 401 || res.status === 403) {
        throw new BolagsverketError('refused', `Bolagsverket ${method} ${path} refused: ${errorMessage(body, res.status)}`, {
          status: res.status,
          body,
        });
      }
      return { status: res.status, body };
    }
  }

  private upstream(what: string, status: number, body: string): BolagsverketError {
    return new BolagsverketError('upstream', `${what} failed: ${errorMessage(body, status)}`, { status, body });
  }

  /**
   * The health call (scope `…:ping`): proves the client mints a token and the gateway
   * answers. Answers the environment and the scopes the mint granted, which is all a client
   * credential says about itself: the token names no account.
   */
  async ping(): Promise<{ environment: BolagsverketEndpoints['environment']; scopes: string[] }> {
    const { status, body } = await this.request('GET', '/isalive');
    if (status < 200 || status >= 300) throw this.upstream('Bolagsverket ping', status, body);
    return { environment: this.endpoints.environment, scopes: this.token.scopes ?? [] };
  }

  /**
   * Look an organisation number up.
   *
   * The number is parsed first, and a refused one throws `invalid_orgnr` without a single
   * request: not to the token endpoint, not to the API. A 404 and an empty list both mean
   * the register has no such entry, which is an answer (`exists: false`).
   */
  async validateOrganisation(input: string): Promise<OrganisationValidation> {
    const parsed = parseOrgnr(input);
    if (!parsed.ok) {
      throw new BolagsverketError('invalid_orgnr', `not a legal entity's organisation number (${parsed.reason})`, {
        reason: parsed.reason,
      });
    }
    const { orgnr } = parsed;
    const { status, body } = await this.request('POST', '/organisationer', { identitetsbeteckning: orgnr });
    const fetchedAt = new Date(this.now()).toISOString();
    const source = { provider: 'bolagsverket', environment: this.endpoints.environment } as const;
    if (status === 404) return { exists: false, orgnr, source, fetchedAt };
    if (status < 200 || status >= 300) throw this.upstream('Bolagsverket organisation lookup', status, body);

    let response;
    try {
      response = rawOrganisationResponse.parse(JSON.parse(body));
    } catch {
      throw new BolagsverketError('upstream', 'Bolagsverket organisation lookup was not the expected shape', {
        status: 502,
        body: body.slice(0, 500),
      });
    }
    // Compared on the last ten digits, so an answer spelled with a dash or the `16` prefix
    // still matches; an entry for any other number is not this answer.
    const match = (response.organisationer ?? []).find(
      (o) => o.organisationsidentitet.identitetsbeteckning.replace(/\D/g, '').slice(-10) === orgnr,
    );
    return match
      ? organisationResult(match, orgnr, this.endpoints.environment, fetchedAt)
      : { exists: false, orgnr, source, fetchedAt };
  }
}
