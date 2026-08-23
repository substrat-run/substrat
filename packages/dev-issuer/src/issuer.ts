/**
 * A real OpenID Connect provider, with exactly one shortcut: `/authorize` shows a list of
 * names and returns as soon as you click one, instead of asking for a password.
 *
 * Everything else is the genuine protocol — discovery, JWKS, Authorization Code + PKCE, a
 * signed ID token with `nonce` — because the point is that the app talking to it runs its
 * PRODUCTION login path. A vertical wired to this issuer holds no dev branch, no
 * impersonation header and no persona list: it is an ordinary relying party, and swapping
 * this issuer for a real one is a config change. That is the whole design.
 *
 * **Stateless.** There is no session store, no code store, and no issuer cookie. An
 * authorization code IS a short-lived JWT carrying everything `/token` must check
 * (subject, client, redirect URI, nonce, PKCE challenge), signed with the key in
 * `keys.ts`. Two consequences worth knowing:
 *
 *   - Restarting the issuer invalidates nothing, so a dev server and a test script can
 *     restart independently of each other.
 *   - Having no SSO session, the picker appears on EVERY `/authorize` — which is what you
 *     want from a dev issuer. Switching user is one click, not a logout dance, and
 *     `prompt=select_account` (what the platform's RP sends for "use another account")
 *     needs no special handling because it is already the only behaviour.
 *
 * Never deploy this. The signing key is checked in — see `keys.ts`.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { SignJWT, jwtVerify, importJWK, type JWTPayload } from 'jose';
import { DEV_ALG, DEV_KID, DEV_PRIVATE_JWK, DEV_PUBLIC_JWK } from './keys.js';
import type { DevPersona } from './personas.js';

export interface DevIssuerOptions {
  /** The cast the picker offers. The `sub` values are the contract with the app's directory. */
  personas: DevPersona[];
  /**
   * Pin the `issuer` value instead of deriving it from the request's own origin.
   * Leave unset: derived means discovery is always self-consistent with whatever host
   * the relying party actually reached, which is what a local RP needs.
   */
  issuer?: string;
  /** ID/access token lifetime in seconds (default 1 hour). */
  tokenTtlSec?: number;
  /**
   * Extra redirect-URI prefixes to accept beyond loopback. Loopback (`http://localhost:*`,
   * `http://127.0.0.1:*`, `http://[::1]:*`) is always accepted; anything else is refused so a
   * stray instance cannot be pointed at a third-party URL and used as an open redirector.
   */
  allowedRedirectPrefixes?: string[];
}

const CODE_TTL_SEC = 300;

/** A parsed `/authorize` request — everything the code must carry to `/token`. */
interface AuthzRequest {
  clientId: string;
  redirectUri: string;
  state: string | undefined;
  nonce: string | undefined;
  codeChallenge: string | undefined;
  scope: string;
  prompt: string | undefined;
  loginHint: string | undefined;
}

/**
 * Sign with the private half, verify with the public one. They are separate imports on
 * purpose: a WebCrypto key carries its allowed operations, so the private key imported for
 * `sign` cannot verify — which is what made the authorization code, verified here on its way
 * back in, fail against itself.
 */
type ImportedKey = Awaited<ReturnType<typeof importJWK>>;
let cachedPrivate: Promise<ImportedKey> | undefined;
let cachedPublic: Promise<ImportedKey> | undefined;
function signingKey(): Promise<ImportedKey> {
  cachedPrivate ??= importJWK(DEV_PRIVATE_JWK, DEV_ALG);
  return cachedPrivate;
}
function verificationKey(): Promise<ImportedKey> {
  cachedPublic ??= importJWK(DEV_PUBLIC_JWK, DEV_ALG);
  return cachedPublic;
}

const enc = new TextEncoder();
const b64url = (bytes: ArrayBuffer | Uint8Array): string => {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

async function sign(claims: JWTPayload, ttlSec: number): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: DEV_ALG, kid: DEV_KID, typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime(`${ttlSec}s`)
    .sign(await signingKey());
}

/** Loopback always; anything else only if explicitly allowed. */
function redirectAllowed(uri: string, extra: string[]): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  const loopback =
    u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname === '::1');
  return loopback || extra.some((p) => uri.startsWith(p));
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Send the browser back to the relying party with an OAuth error, per RFC 6749 §4.1.2.1 —
 * but only once the redirect URI is known to be safe. Before that point the only correct
 * answer is a plain response, because redirecting is exactly what we have not yet validated.
 */
function redirectError(c: Context, redirectUri: string, state: string | undefined, error: string, description: string) {
  const u = new URL(redirectUri);
  u.searchParams.set('error', error);
  u.searchParams.set('error_description', description);
  if (state) u.searchParams.set('state', state);
  return c.redirect(u.toString());
}

export function createDevIssuer(opts: DevIssuerOptions): Hono {
  const personas = opts.personas;
  const ttl = opts.tokenTtlSec ?? 3600;
  const extraRedirects = opts.allowedRedirectPrefixes ?? [];
  const app = new Hono();

  const issuerOf = (c: Context): string => opts.issuer ?? new URL(c.req.url).origin;
  const personaOf = (sub: string): DevPersona | undefined => personas.find((p) => p.sub === sub);

  const claimsFor = (p: DevPersona) => ({
    sub: p.sub,
    name: p.name,
    email: p.email,
    email_verified: true,
  });

  // ── Discovery ──────────────────────────────────────────────────────────────────────
  app.get('/.well-known/openid-configuration', (c) => {
    const issuer = issuerOf(c);
    return c.json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks.json`,
      userinfo_endpoint: `${issuer}/userinfo`,
      end_session_endpoint: `${issuer}/logout`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: [DEV_ALG],
      scopes_supported: ['openid', 'email', 'profile'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
      code_challenge_methods_supported: ['S256'],
      claims_supported: ['sub', 'name', 'email', 'email_verified', 'nonce', 'aud', 'exp', 'iat', 'iss'],
    });
  });

  app.get('/jwks.json', (c) => c.json({ keys: [DEV_PUBLIC_JWK] }));

  // ── Authorization ──────────────────────────────────────────────────────────────────
  /**
   * One endpoint, two states: without `sub` it renders the picker, with a known `sub` it
   * issues the code. The picker's links carry the original query string back verbatim plus
   * the chosen `sub`, so nothing about the request needs to be remembered between them —
   * which is what lets the issuer keep no state at all.
   */
  app.get('/authorize', async (c) => {
    const q = c.req.query();
    const redirectUri = q.redirect_uri ?? '';
    // Validate the redirect target FIRST: every other error is reported by redirecting to
    // it, and an unvalidated redirect is the one thing that must never happen.
    if (!redirectUri) return c.text('missing redirect_uri', 400);
    if (!redirectAllowed(redirectUri, extraRedirects)) {
      return c.text(
        `refusing to redirect to ${redirectUri} — the dev issuer accepts loopback URIs only ` +
          '(pass allowedRedirectPrefixes to widen it)',
        400,
      );
    }

    const req: AuthzRequest = {
      clientId: q.client_id ?? '',
      redirectUri,
      state: q.state,
      nonce: q.nonce,
      codeChallenge: q.code_challenge,
      scope: q.scope ?? 'openid',
      prompt: q.prompt,
      loginHint: q.login_hint,
    };

    if (!req.clientId) return redirectError(c, redirectUri, req.state, 'invalid_request', 'missing client_id');
    if ((q.response_type ?? '') !== 'code') {
      return redirectError(c, redirectUri, req.state, 'unsupported_response_type', 'only response_type=code is supported');
    }
    if (q.code_challenge && (q.code_challenge_method ?? 'plain') !== 'S256') {
      return redirectError(c, redirectUri, req.state, 'invalid_request', 'only code_challenge_method=S256 is supported');
    }
    // No SSO session exists here by design, so `prompt=none` can only ever fail — and
    // saying so is more useful than silently showing the picker it asked us not to.
    if (req.prompt === 'none') {
      return redirectError(c, redirectUri, req.state, 'login_required', 'the dev issuer holds no session; a user must be picked');
    }

    const sub = q.sub;
    if (!sub) return c.html(pickerPage(req, personas, issuerOf(c)));
    const persona = personaOf(sub);
    if (!persona) return c.html(pickerPage(req, personas, issuerOf(c), `Unknown user "${sub}".`), 400);

    const code = await sign(
      {
        typ: 'code',
        sub: persona.sub,
        cid: req.clientId,
        ru: req.redirectUri,
        ...(req.nonce ? { n: req.nonce } : {}),
        ...(req.codeChallenge ? { cc: req.codeChallenge } : {}),
      },
      CODE_TTL_SEC,
    );
    const back = new URL(req.redirectUri);
    back.searchParams.set('code', code);
    if (req.state) back.searchParams.set('state', req.state);
    return c.redirect(back.toString());
  });

  // ── Token ──────────────────────────────────────────────────────────────────────────
  /**
   * The client secret is accepted and NOT checked. A dev issuer that registered no clients
   * has no secret to compare against, and pretending otherwise would only mean inventing a
   * registration step — the friction this exists to remove. PKCE *is* checked, because it
   * is what binds the exchange to the browser that began it and the RP always sends it.
   */
  app.post('/token', async (c) => {
    const form = await c.req.parseBody();
    const str = (k: string): string => (typeof form[k] === 'string' ? (form[k] as string) : '');
    const fail = (error: string, description: string, status: 400 | 401 = 400) =>
      c.json({ error, error_description: description }, status);

    if (str('grant_type') !== 'authorization_code') {
      return fail('unsupported_grant_type', 'only authorization_code is supported');
    }
    const code = str('code');
    if (!code) return fail('invalid_request', 'missing code');

    let payload: JWTPayload & { typ?: string; cid?: string; ru?: string; n?: string; cc?: string };
    try {
      payload = (await jwtVerify(code, await verificationKey())).payload;
    } catch {
      return fail('invalid_grant', 'the authorization code is invalid or has expired');
    }
    if (payload.typ !== 'code') return fail('invalid_grant', 'not an authorization code');
    if (payload.cid !== str('client_id')) return fail('invalid_grant', 'client_id does not match the code');
    if (payload.ru !== str('redirect_uri')) return fail('invalid_grant', 'redirect_uri does not match the code');

    if (payload.cc) {
      const verifier = str('code_verifier');
      if (!verifier) return fail('invalid_grant', 'missing code_verifier');
      const challenge = b64url(await crypto.subtle.digest('SHA-256', enc.encode(verifier)));
      if (challenge !== payload.cc) return fail('invalid_grant', 'PKCE verification failed');
    }

    const persona = personaOf(String(payload.sub));
    if (!persona) return fail('invalid_grant', 'the code names a user this issuer no longer serves');

    const issuer = issuerOf(c);
    const base = { iss: issuer, aud: payload.cid, ...claimsFor(persona) };
    const [idToken, accessToken] = await Promise.all([
      sign({ ...base, ...(payload.n ? { nonce: payload.n } : {}) }, ttl),
      sign({ ...base, typ: 'access' }, ttl),
    ]);
    return c.json({ token_type: 'Bearer', expires_in: ttl, id_token: idToken, access_token: accessToken, scope: 'openid email profile' });
  });

  app.get('/userinfo', async (c) => {
    const auth = c.req.header('authorization') ?? '';
    const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : '';
    if (!token) return c.json({ error: 'invalid_token' }, 401);
    try {
      const { payload } = await jwtVerify(token, await verificationKey(), { issuer: issuerOf(c) });
      const persona = personaOf(String(payload.sub));
      if (!persona) return c.json({ error: 'invalid_token' }, 401);
      return c.json(claimsFor(persona));
    } catch {
      return c.json({ error: 'invalid_token' }, 401);
    }
  });

  /**
   * RP-initiated logout. There is no issuer session to end — the picker always asks — so
   * this only honours `post_logout_redirect_uri`, which is what makes the relying party's
   * `?federated` logout land somewhere sensible instead of erroring.
   */
  app.get('/logout', (c) => {
    const to = c.req.query('post_logout_redirect_uri');
    if (to && redirectAllowed(to, extraRedirects)) return c.redirect(to);
    return c.html(signedOutPage());
  });

  // ── The non-interactive door ───────────────────────────────────────────────────────
  /**
   * Mint tokens for a persona with no browser — the escape hatch a test, a curl, or a
   * headless verification script needs.
   *
   * This IS impersonation, and putting it here is the point: it lives in a process that
   * binds to localhost and is never deployed, rather than behind a flag in the vertical,
   * where the same capability ships to production and only an environment variable stands
   * between it and a cross-tenant hole.
   */
  app.post('/dev/token', async (c) => {
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const sub = typeof body.sub === 'string' ? body.sub : '';
    const audience = typeof body.audience === 'string' ? body.audience : 'dev';
    const persona = personaOf(sub);
    if (!persona) {
      return c.json({ error: `unknown sub '${sub}' — known: ${personas.map((p) => p.sub).join(', ')}` }, 400);
    }
    const base = { iss: issuerOf(c), aud: audience, ...claimsFor(persona) };
    const [idToken, accessToken] = await Promise.all([sign(base, ttl), sign({ ...base, typ: 'access' }, ttl)]);
    return c.json({ token_type: 'Bearer', expires_in: ttl, id_token: idToken, access_token: accessToken });
  });

  /** The cast as JSON — what a script enumerates before minting. */
  app.get('/dev/personas', (c) => c.json(personas));

  return app;
}

// ── The picker ───────────────────────────────────────────────────────────────────────

/**
 * Server-rendered, no build step, no client JavaScript. Each entry is a plain link back to
 * `/authorize` carrying the original request plus `sub`, so picking a user is one GET and
 * the browser's own back button behaves.
 */
function pickerPage(req: AuthzRequest, personas: DevPersona[], issuer: string, error?: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: req.clientId,
    redirect_uri: req.redirectUri,
    scope: req.scope,
    ...(req.state ? { state: req.state } : {}),
    ...(req.nonce ? { nonce: req.nonce } : {}),
    ...(req.codeChallenge ? { code_challenge: req.codeChallenge, code_challenge_method: 'S256' } : {}),
  });
  const hinted = req.loginHint?.toLowerCase();
  const rows = personas
    .map((p) => {
      const href = `/authorize?${params.toString()}&sub=${encodeURIComponent(p.sub)}`;
      const match = hinted && p.email.toLowerCase() === hinted ? ' match' : '';
      return `<a class="who${match}" href="${escapeHtml(href)}">
        <span class="avatar">${escapeHtml([...p.name][0] ?? '?')}</span>
        <span class="lines">
          <strong>${escapeHtml(p.name)}</strong>
          <small>${escapeHtml(p.note ?? p.email)}</small>
        </span>
        <code>${escapeHtml(p.sub)}</code>
      </a>`;
    })
    .join('\n');
  return page(
    'Pick a user',
    `<h1>Sign in</h1>
     <p class="sub">Development issuer at <code>${escapeHtml(issuer)}</code> — pick who to be.
        <strong>${escapeHtml(req.clientId)}</strong> is asking.</p>
     ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
     <div class="list">${rows}</div>
     <p class="foot">No passwords: this issuer authenticates nobody. It exists so the app runs its real
        OIDC login locally. Never deploy it — its signing key is public.</p>`,
  );
}

function signedOutPage(): string {
  return page('Signed out', `<h1>Signed out</h1><p class="sub">You can close this tab.</p>`);
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f7f9; --card:#fff; --fg:#14181f; --muted:#5b6472; --line:#e3e6ea; --accent:#3b5bdb; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#14181f; --card:#1c2129; --fg:#e8ebef; --muted:#98a2b3; --line:#2b323c; --accent:#7d94f5; }
  }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--fg);
         font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; padding:32px 16px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:28px; width:min(460px,100%); }
  h1 { margin:0 0 6px; font-size:20px; }
  .sub { margin:0 0 18px; color:var(--muted); font-size:13px; }
  .error { margin:0 0 14px; padding:8px 10px; border-radius:8px; background:#fdecec; color:#a02020; font-size:13px; }
  @media (prefers-color-scheme: dark) { .error { background:#3a1f22; color:#f5b5b5; } }
  .list { display:flex; flex-direction:column; gap:8px; }
  .who { display:flex; align-items:center; gap:12px; padding:10px 12px; border:1px solid var(--line); border-radius:10px;
         text-decoration:none; color:inherit; }
  .who:hover { border-color:var(--accent); background:color-mix(in srgb, var(--accent) 8%, transparent); }
  .who.match { border-color:var(--accent); }
  .avatar { flex:0 0 34px; height:34px; border-radius:50%; display:grid; place-items:center; font-weight:600;
            background:color-mix(in srgb, var(--accent) 16%, transparent); color:var(--accent); }
  .lines { display:flex; flex-direction:column; min-width:0; flex:1; }
  .lines small { color:var(--muted); font-size:12px; }
  code { font:12px ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--muted); }
  .foot { margin:18px 0 0; color:var(--muted); font-size:12px; }
</style></head>
<body><div class="card">${body}</div></body></html>`;
}
