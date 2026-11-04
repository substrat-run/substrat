import { z } from 'zod';
import type { ConnectorConnection } from '@substrat-run/kernel';
import { BOLAGSVERKET_SCOPES, type BolagsverketCredential } from './config.js';
import { BolagsverketError, errorMessage } from './errors.js';

export type Fetch = ConnectorConnection['fetch'];

const tokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive().optional(),
  /** RFC 6749 §5.1: present when the granted scopes differ from those asked for. */
  scope: z.string().optional(),
});

export interface Exchange {
  ok: boolean;
  status: number;
  body: string;
  retryAfter: string | null;
}

/**
 * One request and its whole body. A transport failure (DNS, a timeout, a body cut off) is
 * `upstream`: it says nothing about the credential, and a caller branching on
 * `BolagsverketError.code` must not meet a bare `Error` instead.
 */
export async function exchange(fetch: Fetch, url: string, init: Parameters<Fetch>[1], what: string): Promise<Exchange> {
  try {
    const res = await fetch(url, init);
    return { ok: res.ok, status: res.status, body: await res.text(), retryAfter: res.headers?.get('Retry-After') ?? null };
  } catch (err) {
    throw new BolagsverketError('upstream', `${what} did not answer: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Re-mint this long before the provider's expiry, so a token never dies mid-request. */
const EXPIRY_SKEW_MS = 60_000;
/** Assumed lifetime when the response states none; short enough to be safe. */
const DEFAULT_LIFETIME_S = 300;

/** `application/x-www-form-urlencoded`, built by hand: this package declares no DOM typings. */
function form(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

/**
 * An OAuth2 client-credentials token, minted on demand and cached until shortly before
 * it expires.
 *
 * There is no refresh token: a new token is minted from the same static pair, so an early
 * re-mint costs one round trip and nothing can rotate out from under a concurrent caller.
 * The cache lives as long as the instance, which is one unit of work, so no state builds
 * up in a Worker isolate.
 */
export class ClientCredentialsToken {
  private cached: { value: string; expiresAtMs: number } | null = null;
  /** The mint in flight, shared by every caller that asks while it runs. */
  private minting: Promise<string> | null = null;

  /** The scopes the last mint granted, or `null` before a mint. */
  scopes: string[] | null = null;

  constructor(
    private readonly credential: BolagsverketCredential,
    private readonly tokenUrl: string,
    private readonly fetch: Fetch,
    private readonly now: () => number,
  ) {}

  /** Drop the cached token, after the API refused it. */
  invalidate(): void {
    this.cached = null;
  }

  async get(): Promise<string> {
    if (this.cached && this.cached.expiresAtMs - this.now() > EXPIRY_SKEW_MS) return this.cached.value;
    this.minting ??= this.mint().finally(() => {
      this.minting = null;
    });
    return this.minting;
  }

  private async mint(): Promise<string> {
    const res = await exchange(this.fetch, this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: form({
        grant_type: 'client_credentials',
        client_id: this.credential.clientId,
        client_secret: this.credential.clientSecret,
        scope: BOLAGSVERKET_SCOPES,
      }),
    }, 'Bolagsverket token endpoint');
    const { body } = res;
    if (!res.ok) {
      // RFC 6749 §5.2: a bad client is `400 invalid_client` as often as a 401.
      const refused = res.status === 400 || res.status === 401 || res.status === 403;
      throw new BolagsverketError(
        refused ? 'refused' : 'upstream',
        `Bolagsverket token mint failed: ${errorMessage(body, res.status)}`,
        { status: res.status, body },
      );
    }
    let parsed: z.infer<typeof tokenResponse>;
    try {
      parsed = tokenResponse.parse(JSON.parse(body));
    } catch {
      throw new BolagsverketError('upstream', 'Bolagsverket token response was not the documented shape', {
        status: 502,
        body,
      });
    }
    this.scopes = (parsed.scope ?? BOLAGSVERKET_SCOPES).split(' ').filter((x) => x !== '');
    this.cached = {
      value: parsed.access_token,
      expiresAtMs: this.now() + (parsed.expires_in ?? DEFAULT_LIFETIME_S) * 1000,
    };
    return this.cached.value;
  }
}
