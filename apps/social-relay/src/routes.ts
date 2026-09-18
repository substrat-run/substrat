/**
 * The relay's HTTP surface: a minimal OpenID Provider per upstream, in front of one
 * OAuth client per upstream that only this worker can reach (#1544).
 *
 * A tenant's Auth Server install federates to `…/google`, `…/github` or `…/apple` as an
 * ordinary generic OIDC upstream — discovery, `/authorize`, `/token`, JWKS, `/userinfo` —
 * and never learns anything about the credential behind it. What the install holds is its
 * OWN client at this relay: worth nothing anywhere else, revocable on its own, and
 * useless for reaching any other install's sign-ins.
 *
 * **There is no UI here, by design.** `/authorize` redirects to the upstream and the
 * callback redirects back; the only page this worker ever renders is an error it cannot
 * safely redirect. The screen a person sees is the provider's own, which is also the one
 * honest limitation of a shared client: it carries the platform's name, never the
 * tenant's, because OAuth branding is per client. That is the whole reason the
 * bring-your-own path stays.
 *
 * **There are no users here either.** No sessions, no accounts, no cookie. Had this been
 * a full issuer it would have grown a session at its own origin and quietly become a
 * cross-tenant SSO hub — sign in at one team's app, arrive at another's already
 * authenticated. Everything stored is either the client registry or in-flight state with
 * minutes on its life.
 *
 * Split from `worker.ts` so it never imports `cloudflare:workers` and a node test can
 * drive the whole flow with a fake store and a fake upstream.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { assertPlatformCall, PlatformCallError } from '@substrat-run/kernel';
import type { ClientRecord, RelayStore } from './do-contract.js';
import { providerOf, type UpstreamCredentials, type UpstreamProvider } from './providers.js';
import { publicJwkOf, randomToken, sha256b64url, signJwt, verifyJwt } from './jwt.js';

export interface Env {
  /** The store DO namespace — the real binding in production, a plain fake in tests. */
  RELAY: { idFromName(name: string): unknown; get(id: unknown): unknown };
  /**
   * Pins the issuer origin. Normally unset: the issuer derives from the request's own
   * origin, so discovery can never advertise an origin that does not route here. Set it
   * only behind a proxy that rewrites Host.
   */
  PUBLIC_ORIGIN?: string;
  /** Gates `/internal/*` — the same platform credential every other platform surface uses. */
  PLATFORM_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** Apple's Services ID, plus the three things signing its client secret takes. */
  APPLE_CLIENT_ID?: string;
  APPLE_TEAM_ID?: string;
  APPLE_KEY_ID?: string;
  APPLE_PRIVATE_KEY?: string;
  /** Authorizations per client per minute. Absent ⇒ the default below. */
  AUTHORIZE_RATE_LIMIT?: string;
}

/** How long a started authorization may take to come back from the upstream. */
const FLOW_TTL_MS = 10 * 60 * 1000;
/** How long an issued code may go unredeemed. OIDC says "short"; a token call is immediate. */
const CODE_TTL_MS = 60 * 1000;
const ID_TOKEN_TTL_S = 10 * 60;
const ACCESS_TOKEN_TTL_S = 5 * 60;
const DEFAULT_RATE_LIMIT = 120;

export interface AppOptions {
  /** Injected so tests drive the upstreams without a network. */
  fetchImpl?: typeof globalThis.fetch;
  /** Injected so tests are explicit about expiry instead of sleeping. */
  now?: () => number;
}

/** The store stub for this request. One instance: the registry is global to the relay. */
function storeOf(env: Env): RelayStore {
  return env.RELAY.get(env.RELAY.idFromName('relay')) as RelayStore;
}

/**
 * The issuer for one provider — the string a tenant configures, and the one that must
 * come back out of discovery character for character or nothing downstream matches.
 */
function issuerOf(env: Env, request: Request, provider: string): string {
  const origin = env.PUBLIC_ORIGIN?.replace(/\/+$/, '') ?? new URL(request.url).origin;
  return `${origin}/${provider}`;
}

/**
 * The upstream credentials, or null when this deployment has none for that provider.
 *
 * Null takes the WHOLE provider surface to 404, discovery included, rather than letting
 * it advertise a sign-in that cannot work. A tenant configuring the upstream then fails
 * at save time — where discovery is resolved and a person is still looking at the form —
 * instead of at the first person's first sign-in.
 */
function credentialsFor(env: Env, provider: string): UpstreamCredentials | null {
  if (provider === 'google' && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
  }
  if (provider === 'github' && env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    return { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET };
  }
  if (provider === 'apple' && env.APPLE_CLIENT_ID && env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY) {
    return {
      clientId: env.APPLE_CLIENT_ID,
      clientSecret: '',
      apple: { teamId: env.APPLE_TEAM_ID, keyId: env.APPLE_KEY_ID, privateKeyPem: env.APPLE_PRIVATE_KEY },
    };
  }
  return null;
}

/** A provider this deployment can actually serve, or null. */
function liveProvider(env: Env, id: string): { provider: UpstreamProvider; credentials: UpstreamCredentials } | null {
  const provider = providerOf(id);
  if (!provider) return null;
  const credentials = credentialsFor(env, id);
  return credentials ? { provider, credentials } : null;
}

/** An error that must be reported back to the client application, per OAuth 2.0 §4.1.2.1. */
function redirectError(redirectUri: string, state: string, error: string, description: string): Response {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  url.searchParams.set('error_description', description);
  if (state) url.searchParams.set('state', state);
  return Response.redirect(url.toString(), 302);
}

/**
 * An error that must NOT be redirected: the client or its redirect URI did not check out,
 * so there is no address we are willing to send anything to. This is the only HTML the
 * relay ever serves, and it is deliberately plain — an operator reads it, not a visitor.
 */
function renderError(status: number, error: string, description: string): Response {
  const body = `<!doctype html><meta charset="utf-8"><title>Sign-in error</title>
<h1>Sign-in could not start</h1>
<p><strong>${error}</strong></p>
<p>${description}</p>
<p>This is the platform's sign-in relay. Nothing was sent to the application that sent you here,
because the request did not identify it in a way that could be trusted.</p>`;
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

const registerInput = z.object({
  name: z.string().min(1).max(200),
  redirectUris: z.array(z.string().url()).min(1).max(10),
});

/**
 * A redirect URI the relay will register: HTTPS, or HTTP on a loopback host so a local
 * issuer can be developed against a real relay. No fragment, and no wildcard — every
 * comparison later is exact, which is the only comparison that cannot be tricked.
 */
function acceptableRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash) return false;
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  return url.protocol === 'https:' || (url.protocol === 'http:' && loopback);
}

/**
 * The per-client limit, from config, refusing to be broken by a bad value in EITHER
 * direction: a typo used to read as `NaN` and quietly remove the limit — which is the one
 * outcome this setting exists to prevent — and an empty string as `0`, which refuses every
 * sign-in. Anything that is not a positive number means "the default", never "no limit".
 */
export function rateLimitOf(configured: string | undefined): number {
  const parsed = Number(configured);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RATE_LIMIT;
}

export function createApp(options: AppOptions = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? (() => Date.now());
  const app = new Hono<{ Bindings: Env }>();

  /** What this worker is, for anyone who reaches its root. It has no other page. */
  app.get('/', (c) =>
    c.text(
      "Substrat's social sign-in relay. It holds one OAuth client per upstream so that no tenant has to, and serves one OpenID issuer per provider at /google, /github and /apple.\n",
    ),
  );

  app.get('/:provider/.well-known/openid-configuration', (c) => {
    const live = liveProvider(c.env, c.req.param('provider'));
    if (!live) return c.json({ error: 'unknown or unconfigured provider' }, 404);
    const issuer = issuerOf(c.env, c.req.raw, live.provider.id);
    return c.json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      userinfo_endpoint: `${issuer}/userinfo`,
      jwks_uri: `${issuer}/jwks.json`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['ES256'],
      scopes_supported: ['openid', 'email', 'profile'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      /** PKCE is required, not merely supported — `/authorize` refuses a request without it. */
      code_challenge_methods_supported: ['S256'],
      claims_supported: ['sub', 'email', 'email_verified', 'name', 'picture'],
    });
  });

  app.get('/:provider/jwks.json', async (c) => {
    const live = liveProvider(c.env, c.req.param('provider'));
    if (!live) return c.json({ error: 'unknown or unconfigured provider' }, 404);
    const key = await storeOf(c.env).signingKey();
    return c.json({ keys: [publicJwkOf(key)] });
  });

  /**
   * Start a round. Two classes of failure, and which class a failure is decides where its
   * report goes: anything about the CLIENT is rendered here (there is no trustworthy
   * address to send it to), anything about the request is redirected back to the client
   * the way an OAuth client expects to hear about it.
   */
  app.get('/:provider/authorize', async (c) => {
    const live = liveProvider(c.env, c.req.param('provider'));
    if (!live) return renderError(404, 'unsupported_provider', 'This relay does not serve that provider.');
    const query = c.req.query();
    const clientId = query.client_id ?? '';
    const redirectUri = query.redirect_uri ?? '';
    const state = query.state ?? '';

    const store = storeOf(c.env);
    const client: ClientRecord | null = clientId ? await store.getClient(clientId) : null;
    if (!client) return renderError(400, 'invalid_client', 'No application is registered under that client id.');
    if (client.disabled) {
      return renderError(403, 'access_denied', 'Sign-in through the platform relay is suspended for this application.');
    }
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
      return renderError(400, 'invalid_request', 'That redirect URI is not registered for this application.');
    }

    if ((query.response_type ?? '') !== 'code') {
      return redirectError(redirectUri, state, 'unsupported_response_type', 'Only the authorization code flow is served.');
    }
    const codeChallenge = query.code_challenge ?? '';
    if (!codeChallenge || (query.code_challenge_method ?? '') !== 'S256') {
      return redirectError(redirectUri, state, 'invalid_request', 'PKCE with S256 is required.');
    }

    const limit = rateLimitOf(c.env.AUTHORIZE_RATE_LIMIT);
    const hits = await store.countAuthorize(clientId, now());
    if (hits > limit) {
      return redirectError(redirectUri, state, 'temporarily_unavailable', 'Too many sign-in attempts; try again shortly.');
    }

    const flowId = randomToken();
    await store.putFlow(
      flowId,
      {
        provider: live.provider.id,
        clientId,
        redirectUri,
        state,
        nonce: query.nonce,
        codeChallenge,
      },
      now() + FLOW_TTL_MS,
    );

    const upstream = new URL(live.provider.authorizeUrl);
    upstream.searchParams.set('client_id', live.credentials.clientId);
    upstream.searchParams.set('redirect_uri', `${issuerOf(c.env, c.req.raw, live.provider.id)}/callback`);
    upstream.searchParams.set('response_type', 'code');
    upstream.searchParams.set('scope', live.provider.scope);
    upstream.searchParams.set('state', flowId);
    for (const [key, value] of Object.entries(live.provider.authorizeParams)) upstream.searchParams.set(key, value);
    return c.redirect(upstream.toString(), 302);
  });

  /**
   * The upstream's answer. One handler for both methods: Apple posts a form because it
   * will not return a name or an email any other way, and the other two come back as a
   * redirect — but what happens to the answer is identical either way.
   */
  const callback = async (c: { env: Env; req: { raw: Request; param(name: string): string } }) => {
    const live = liveProvider(c.env, c.req.param('provider'));
    if (!live) return renderError(404, 'unsupported_provider', 'This relay does not serve that provider.');
    const request = c.req.raw;
    const url = new URL(request.url);
    const form =
      request.method === 'POST' ? new URLSearchParams(await request.text()) : new URLSearchParams(url.search);

    const flowId = form.get('state') ?? '';
    const store = storeOf(c.env);
    const flow = flowId ? await store.takeFlow(flowId, live.provider.id, now()) : null;
    if (!flow) {
      return renderError(400, 'invalid_request', 'This sign-in round has expired or was already completed.');
    }

    const upstreamError = form.get('error');
    if (upstreamError) {
      return redirectError(
        flow.redirectUri,
        flow.state,
        upstreamError,
        form.get('error_description') ?? 'The provider declined the sign-in.',
      );
    }
    const code = form.get('code') ?? '';
    if (!code) return redirectError(flow.redirectUri, flow.state, 'invalid_request', 'The provider returned no code.');

    /**
     * The flow is already spent by the take above, so from here on there is exactly one
     * acceptable way to fail: back at the install, with an error it can render. A throw
     * would be a 500 on the relay's own origin — a dead end with no route back to the app
     * the person came from. Both of the reachable throws are real: `fetch` rejects when an
     * upstream is unreachable, and Apple's secret signing throws on a `.p8` that was
     * mangled on its way into the secret store.
     */
    let tokenResponse: Response;
    try {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${issuerOf(c.env, request, live.provider.id)}/callback`,
        client_id: live.credentials.clientId,
        client_secret: await live.provider.clientSecretFor(live.credentials, now()),
      });
      tokenResponse = await fetchImpl(live.provider.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: body.toString(),
      });
    } catch {
      return redirectError(flow.redirectUri, flow.state, 'server_error', 'The provider could not be reached.');
    }
    const tokens = (await tokenResponse.json().catch(() => ({}))) as {
      access_token?: string;
      id_token?: string;
      error?: string;
      error_description?: string;
    };
    if (!tokenResponse.ok || tokens.error) {
      return redirectError(
        flow.redirectUri,
        flow.state,
        'server_error',
        tokens.error_description ?? tokens.error ?? 'The provider refused the code exchange.',
      );
    }

    let profile;
    try {
      profile = await live.provider.profileFrom(tokens, fetchImpl, { formUser: form.get('user') ?? undefined });
    } catch {
      return redirectError(flow.redirectUri, flow.state, 'server_error', 'The provider returned no usable identity.');
    }
    if (!profile.sub) {
      return redirectError(flow.redirectUri, flow.state, 'server_error', 'The provider returned no subject.');
    }

    const issuedCode = randomToken();
    await store.putCode(
      issuedCode,
      {
        provider: live.provider.id,
        clientId: flow.clientId,
        redirectUri: flow.redirectUri,
        nonce: flow.nonce,
        codeChallenge: flow.codeChallenge,
        sub: profile.sub,
        email: profile.email,
        emailVerified: profile.emailVerified,
        name: profile.name,
        picture: profile.picture,
      },
      now() + CODE_TTL_MS,
    );

    const back = new URL(flow.redirectUri);
    back.searchParams.set('code', issuedCode);
    if (flow.state) back.searchParams.set('state', flow.state);
    return Response.redirect(back.toString(), 302);
  };

  app.get('/:provider/callback', callback);
  app.post('/:provider/callback', callback);

  app.post('/:provider/token', async (c) => {
    const live = liveProvider(c.env, c.req.param('provider'));
    if (!live) return c.json({ error: 'invalid_request', error_description: 'unknown provider' }, 404);
    const form = new URLSearchParams(await c.req.raw.text());

    /** `client_secret_basic` and `client_secret_post`; discovery advertises both. */
    let clientId = form.get('client_id') ?? '';
    let clientSecret = form.get('client_secret') ?? '';
    const authorization = c.req.raw.headers.get('authorization') ?? '';
    if (authorization.toLowerCase().startsWith('basic ')) {
      // Both `atob` and `decodeURIComponent` throw on input that is merely malformed, and
      // a malformed credential is a failed authentication — a 401 the caller can read —
      // never a 500 that reads as the relay being broken.
      try {
        const decoded = atob(authorization.slice(6).trim());
        const separator = decoded.indexOf(':');
        if (separator > 0) {
          clientId = decodeURIComponent(decoded.slice(0, separator));
          clientSecret = decodeURIComponent(decoded.slice(separator + 1));
        }
      } catch {
        clientId = '';
        clientSecret = '';
      }
    }
    const store = storeOf(c.env);
    if (!clientId || !clientSecret || !(await store.verifyClientSecret(clientId, clientSecret))) {
      return c.json({ error: 'invalid_client', error_description: 'client authentication failed' }, 401);
    }
    /**
     * The kill switch is checked HERE as well as at `/authorize`, because suspending an
     * install between the two would otherwise still hand it a ten-minute id_token for
     * every code minted in the preceding minute. A switch that takes a minute to take
     * effect is not the switch anyone reaches for it to be.
     */
    if ((await store.getClient(clientId))?.disabled !== false) {
      return c.json({ error: 'invalid_client', error_description: 'client authentication failed' }, 401);
    }
    if ((form.get('grant_type') ?? '') !== 'authorization_code') {
      return c.json({ error: 'unsupported_grant_type', error_description: 'only authorization_code is served' }, 400);
    }

    const record = await store.takeCode(form.get('code') ?? '', live.provider.id, now());
    /**
     * Every mismatch below answers `invalid_grant` with the same wording. The code has
     * already been consumed by the take, so a caller learns only that it did not work —
     * never which of "wrong client", "wrong redirect" or "wrong verifier" it was.
     */
    const invalid = () => c.json({ error: 'invalid_grant', error_description: 'the code is not valid' }, 400);
    if (!record || record.clientId !== clientId || record.provider !== live.provider.id) return invalid();
    if (record.redirectUri !== (form.get('redirect_uri') ?? '')) return invalid();
    const verifier = form.get('code_verifier') ?? '';
    if (!verifier || (await sha256b64url(verifier)) !== record.codeChallenge) return invalid();

    const key = await store.signingKey();
    const issuer = issuerOf(c.env, c.req.raw, live.provider.id);
    const issuedAt = Math.floor(now() / 1000);
    const identity = {
      sub: record.sub,
      ...(record.email ? { email: record.email } : {}),
      ...(record.emailVerified === undefined ? {} : { email_verified: record.emailVerified }),
      ...(record.name ? { name: record.name } : {}),
      ...(record.picture ? { picture: record.picture } : {}),
    };
    const idToken = await signJwt(key, {
      iss: issuer,
      aud: clientId,
      iat: issuedAt,
      exp: issuedAt + ID_TOKEN_TTL_S,
      auth_time: issuedAt,
      ...(record.nonce ? { nonce: record.nonce } : {}),
      ...identity,
    });
    /**
     * The access token is a signed JWT rather than an opaque handle, because `/userinfo`
     * has nothing to look a handle up in — the relay keeps no record of a completed
     * sign-in, and adding one to serve an endpoint would undo the property that makes
     * this worker cheap to reason about. The token IS the record, for five minutes.
     */
    const accessToken = await signJwt(key, {
      iss: issuer,
      aud: `${issuer}/userinfo`,
      iat: issuedAt,
      exp: issuedAt + ACCESS_TOKEN_TTL_S,
      ...identity,
    });
    return c.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_S,
      id_token: idToken,
      scope: 'openid email profile',
    });
  });

  app.get('/:provider/userinfo', async (c) => {
    const live = liveProvider(c.env, c.req.param('provider'));
    if (!live) return c.json({ error: 'unknown provider' }, 404);
    const authorization = c.req.header('authorization') ?? '';
    if (!authorization.toLowerCase().startsWith('bearer ')) {
      return c.json({ error: 'invalid_token' }, 401, { 'www-authenticate': 'Bearer' });
    }
    const key = await storeOf(c.env).signingKey();
    const claims = await verifyJwt(key, authorization.slice(7).trim(), now());
    const issuer = issuerOf(c.env, c.req.raw, live.provider.id);
    if (!claims || claims.aud !== `${issuer}/userinfo`) {
      return c.json({ error: 'invalid_token' }, 401, { 'www-authenticate': 'Bearer' });
    }
    const { iss, aud, iat, exp, ...identity } = claims;
    return c.json(identity);
  });

  /**
   * The platform surface (K-31), gated by `PLATFORM_SECRET` exactly as every other
   * `/internal/*` is. Registration is NOT open: RFC 7591 in the open would let anyone mint
   * a client on the platform's Google quota, and the platform is the party that knows
   * which hostname belongs to which install — so it registers, and it validates.
   */
  const platform = new Hono<{ Bindings: Env }>();
  platform.use('*', async (c, next) => {
    try {
      assertPlatformCall(c.req.raw.headers, { expectedSecret: c.env.PLATFORM_SECRET });
    } catch (e) {
      if (e instanceof PlatformCallError) return c.json({ error: e.message }, 403);
      throw e;
    }
    await next();
  });

  platform.post('/clients', async (c) => {
    const parsed = registerInput.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'name and redirectUris are required' }, 400);
    const bad = parsed.data.redirectUris.filter((uri) => !acceptableRedirectUri(uri));
    if (bad.length) {
      return c.json({ error: `redirect URIs must be https (or http on loopback) and carry no fragment: ${bad.join(', ')}` }, 400);
    }
    const created = await storeOf(c.env).registerClient(parsed.data, now());
    return c.json(created, 201);
  });

  platform.get('/clients', async (c) => c.json({ clients: await storeOf(c.env).listClients() }));

  platform.post('/clients/:clientId/disabled', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { disabled?: boolean };
    const ok = await storeOf(c.env).setClientDisabled(c.req.param('clientId'), body.disabled !== false);
    return ok ? c.json({ ok: true }) : c.json({ error: 'no such client' }, 404);
  });

  platform.delete('/clients/:clientId', async (c) => {
    const ok = await storeOf(c.env).deleteClient(c.req.param('clientId'));
    return ok ? c.json({ ok: true }) : c.json({ error: 'no such client' }, 404);
  });

  app.route('/internal', platform);

  /** An unknown `/internal/*` path answers JSON, never a page — a platform caller parses. */
  app.all('/internal/*', (c) => c.json({ error: 'not implemented' }, 501));

  return app;
}

export default createApp();
