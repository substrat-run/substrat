import type { Hono } from 'hono';
import {
  sessionFromHeaders,
  mintSession,
  signEphemeral,
  verifyEphemeral,
  pkceS256,
  type OidcEnv,
  type SessionUser,
} from '@substrat-run/oidc-rp';

/**
 * The CLI login broker — a loopback OAuth flow for `substrat login`, brokered by the
 * control plane so the CLI never touches AuthHero directly (self-serve-deploy.md; the
 * control plane already does the AuthHero round-trip for the console).
 *
 *   substrat login  ─▶  GET /api/auth/cli?port&state&challenge
 *                        (no session ⇒ bounce through /api/auth/login, return here)
 *                    ─▶  302 http://127.0.0.1:PORT/callback?code&state
 *   substrat exchange ─▶ POST /api/auth/cli/token {code, verifier}  ─▶  { token }
 *
 * PKCE binds the exchange to the CLI that began it: the `code` (a 2-minute signed
 * envelope) is useless to anyone who intercepts the loopback redirect without the
 * `verifier`, and the real session token is returned only over the direct HTTPS POST —
 * never in a URL. The token is the same signed session the cookie carries, so
 * `oidcStaffBearerReader` + the roster gate it exactly like a browser session.
 */

/** The loopback `code`'s lifetime — long enough to exchange, short enough to not linger. */
const CODE_MAXAGE = 120;

export function mountCliAuthRoutes<B extends OidcEnv>(app: Hono<{ Bindings: B }>): void {
  app.get('/api/auth/cli', async (c) => {
    const url = new URL(c.req.raw.url);
    const port = Number(url.searchParams.get('port'));
    const state = url.searchParams.get('state') ?? '';
    const challenge = url.searchParams.get('challenge') ?? '';
    // A loopback port (built into a 127.0.0.1 URL below — never an arbitrary host), plus
    // the CLI's state echo and its PKCE challenge. Anything missing is a malformed call.
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || !state || !challenge) {
      return c.text('bad cli login request', 400);
    }

    // `fresh=1` (`substrat login --fresh`) means "as a different account": skip any live
    // browser session and force the IdP to re-prompt (`prompt=login`) past its SSO cookie.
    // Dropped from the returnTo so the post-login bounce back here uses the NEW session
    // instead of looping.
    const fresh = url.searchParams.get('fresh') !== null;
    const user = fresh ? null : await sessionFromHeaders(c.env, c.req.raw.headers);
    if (!user) {
      // No (usable) session yet: bounce through the normal browser login, which returns
      // here (now with a session cookie) via the same-origin returnTo.
      const params = new URLSearchParams(url.searchParams);
      params.delete('fresh');
      const returnTo = `/api/auth/cli?${params.toString()}`;
      return c.redirect(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}${fresh ? '&prompt=login' : ''}`);
    }

    const code = await signEphemeral(
      c.env,
      { sub: user.id, email: user.email, name: user.name, ch: challenge, purpose: 'cli' },
      CODE_MAXAGE,
    );
    const target = new URL(`http://127.0.0.1:${port}/callback`);
    target.searchParams.set('code', code);
    target.searchParams.set('state', state);
    return c.redirect(target.toString());
  });

  app.post('/api/auth/cli/token', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { code?: string; verifier?: string } | null;
    if (!body?.code || !body?.verifier) return c.json({ error: 'missing code or verifier' }, 400);

    const payload = await verifyEphemeral(c.env, body.code);
    if (!payload || payload.purpose !== 'cli') return c.json({ error: 'invalid or expired code' }, 400);
    if (payload.ch !== (await pkceS256(body.verifier))) {
      return c.json({ error: 'pkce verification failed' }, 400);
    }

    const user: SessionUser = {
      id: String(payload.sub),
      email: typeof payload.email === 'string' ? payload.email : undefined,
      name: typeof payload.name === 'string' ? payload.name : undefined,
    };
    const token = await mintSession(c.env, user);
    return c.json({ token });
  });
}
