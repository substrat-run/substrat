import { connectionId as connectionIdSchema } from '@substrat-run/contracts';
import type { ConnectorConnection, FetchLike } from '@substrat-run/kernel';
import {
  FortnoxApi,
  FortnoxApiError,
  FORTNOX_API_BASE,
  FORTNOX_OAUTH_BASE,
  fortnoxCompany,
  fortnoxSecret,
  type FortnoxCompany,
  type FortnoxSecret,
} from './api.js';

// Web-standard everywhere this runs (Node, Workers); declared locally so the
// connector pulls in no platform typings, exactly as `api.ts` does.
declare const btoa: (data: string) => string;
declare const URLSearchParams: new (init: Record<string, string>) => { toString(): string };

/**
 * Complete a service consent: the one-time authorization-code round, packaged.
 *
 * This is the step between "a person clicked approve at Fortnox" and "a connection
 * exists" — the exact sequence `scripts/connect.mts` runs locally, exported so a
 * hosted connect flow (the dashboard's Connect button, #1220) is the same shipped
 * code rather than a reimplementation:
 *
 * 1. Exchange the one-time `code` (`grant_type=authorization_code`). The ONLY place
 *    this flow is ever used; the tokens it yields are discarded after step 2.
 * 2. Read `GET /3/companyinformation` — the consent's company, and its
 *    `DatabaseNumber`, which is the credential's `tenantId` and is shown nowhere
 *    else.
 * 3. **Mint again with `client_credentials`** from the assembled triple. This is the
 *    connector's whole premise (a service consent mintable from static values, no
 *    refresh token), so it is proven here, at connect time, in the operator's hands —
 *    never first discovered by a background sweep.
 *
 * What comes back is the sealed-ready secret plus the company it names, so a connect
 * flow can both store the credential and show a person WHICH company they just
 * attached — the check that catches a consent granted while signed into the wrong
 * company switcher entry.
 */
export interface FortnoxConsentCompletion {
  secret: FortnoxSecret;
  company: FortnoxCompany;
  /** Visible to the client-credentials token — proof the mint reads real data. */
  financialYears: number;
}

export async function completeFortnoxConsent(input: {
  clientId: string;
  clientSecret: string;
  /** The one-time `code` the consent redirect carried. */
  code: string;
  /** Must EXACTLY match the redirect URI registered in the Developer Portal. */
  redirectUri: string;
  fetch: FetchLike;
  oauthBase?: string;
  apiBase?: string;
  now?: () => number;
}): Promise<FortnoxConsentCompletion> {
  const oauthBase = input.oauthBase ?? FORTNOX_OAUTH_BASE;
  const apiBase = input.apiBase ?? FORTNOX_API_BASE;

  // 1. The code exchange. Failures carry Fortnox's own words: `invalid_grant` here
  // usually means the code was already spent (a reloaded callback tab) or the
  // redirect URI differs from the registered one.
  const tokenRes = await input.fetch(`${oauthBase}/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${input.clientId}:${input.clientSecret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
    }).toString(),
  });
  const tokenBody = await tokenRes.text();
  if (!tokenRes.ok) {
    throw new FortnoxApiError(
      `Fortnox code exchange failed: ${sliceError(tokenBody, tokenRes.status)}`,
      tokenRes.status,
      tokenBody,
    );
  }
  let accessToken: string | undefined;
  try {
    accessToken = (JSON.parse(tokenBody) as { access_token?: string }).access_token;
  } catch {
    // fall through to the throw below — a non-JSON 200 is a broken exchange too.
  }
  if (!accessToken) {
    throw new FortnoxApiError('no access_token in Fortnox code-exchange response', 502, tokenBody);
  }

  // 2. WHICH company consented — `DatabaseNumber` is the whole reason this read exists.
  const infoRes = await input.fetch(`${apiBase}/companyinformation`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  const infoBody = await infoRes.text();
  if (!infoRes.ok) {
    throw new FortnoxApiError(
      `Fortnox companyinformation failed: ${sliceError(infoBody, infoRes.status)}`,
      infoRes.status,
      infoBody,
    );
  }
  let company: FortnoxCompany;
  try {
    const raw = JSON.parse(infoBody) as { CompanyInformation?: unknown };
    company = fortnoxCompany.parse(raw.CompanyInformation ?? raw);
  } catch {
    throw new FortnoxApiError('Fortnox companyinformation was not the documented shape', 502, infoBody);
  }
  if (company.DatabaseNumber === undefined) {
    throw new FortnoxApiError(
      'Fortnox companyinformation carried no DatabaseNumber — cannot key the connection',
      502,
      infoBody,
    );
  }

  // A header value, never arithmetic — and `fortnoxSecret` wants a digit-only string.
  const secret = fortnoxSecret.parse({
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    tenantId: String(company.DatabaseNumber),
  });

  // 3. THE claim: the triple mints via client_credentials, with no refresh token in
  // play. `financialYears` (the cheapest scoped read the sweep itself needs) proves the
  // token reads real data — a mint that cannot read would connect a scope the first
  // sweep then fails on.
  const api = new FortnoxApi(bareConnection(secret, input.fetch), {
    apiBase,
    oauthBase,
    ...(input.now ? { now: input.now } : {}),
  });
  const years = await api.financialYears();

  return { secret, company, financialYears: years.length };
}

/** A bare connection carrying a candidate secret — the same shape the probe builds. */
function bareConnection(secret: FortnoxSecret, fetchImpl: FetchLike): ConnectorConnection {
  return {
    id: connectionIdSchema.parse('00000000000000000000000000'), // no row yet; never read
    tenantId: '',
    vertical: '',
    provider: 'fortnox',
    secret,
    expiresAt: null,
    fetch: fetchImpl,
  };
}

/** The provider's own message where it sent one; the raw slice beats a bare status. */
function sliceError(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as { error_description?: string; error?: string };
    const found = parsed.error_description ?? parsed.error;
    if (typeof found === 'string' && found !== '') return found;
  } catch {
    // Not JSON — fall through.
  }
  const slice = body.trim().slice(0, 200);
  return slice === '' ? `HTTP ${status}` : slice;
}
