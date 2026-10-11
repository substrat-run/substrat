/**
 * The HTTP app the dev server serves — built here, not in `server.ts`, so a test drives
 * the same wiring a browser does (the scenario suite never reaches it).
 *
 * Authentication is an ordinary OIDC round-trip against whatever `OIDC_ISSUER` names —
 * locally `@substrat-run/dev-issuer`, a real provider you sign into by picking a name.
 */
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { substratError } from '@substrat-run/contracts';
import type { DevLogin } from '@substrat-run/dev-issuer';
import type { ScopeHost } from '@substrat-run/kernel';
import { emailRefusalMessage, identifyEmail, type EmailIdentityEnv } from '@substrat-run/oidc-rp';
import { problemResponse } from '@substrat-run/vertical-host';
import { API_DOCUMENT } from './api.js';
import { mountApi } from './routes.js';

export interface AppOptions {
  host: Pick<ScopeHost, 'getScope'>;
  login: Pick<DevLogin, 'handle' | 'subject' | 'caller'>;
  /** Where `OIDC_ALLOW_UNVERIFIED_EMAIL` is read from — `process.env` in the dev server. */
  env: EmailIdentityEnv;
}

export function createApp({ host, login, env }: AppOptions): Hono {
  const app = new Hono();

  // The relying-party endpoints. Accounts and passwords live at the issuer; this vertical
  // has no credential store and hosts no sign-up.
  app.on(['GET', 'POST'], '/api/auth/*', (c) => login.handle(c.req.raw));

  /** Who is signed in — the shape the app's header renders, or 401. */
  app.get('/api/me', async (c) => {
    const caller = await login.caller(c.req.raw.headers);
    if (!caller) return c.json({ error: 'unauthorized' }, 401);
    return c.json({ principal: caller.principal, display: caller.display });
  });

  // The document this vertical's own operations describe, served from its own
  // origin. Computed once at boot from the same declarations the routes below are
  // derived from — never read from the checked-in `openapi.json`, which exists so
  // a surface change shows up in a PR diff (api-surface.md §2.4) rather than to be
  // served. No `/api/docs` page: rendering one means bundling Scalar, and the
  // smallest vertical that is still a real one does not need a second dependency
  // to prove the document is reachable.
  app.get('/openapi.json', (c) => c.json(API_DOCUMENT));

  /**
   * Joining records the address `todo/share-list` finds you by, so it must be one the
   * issuer verified this session controls (#1359) — never whatever the body claims. The
   * operation cannot see the session, so the check sits here, in front of its route.
   * Anything else wrong with the body is left to the operation's own input parse.
   */
  app.post('/api/join', async (c, next) => {
    const subject = await login.subject(c.req.raw.headers);
    if (!subject) return next(); // the mount answers 401
    const own = identifyEmail(env, { id: subject.sub, email: subject.email ?? undefined, emailVerified: subject.emailVerified });
    if (own.email === null) {
      return problemResponse(c, substratError('permission_denied', `joining needs a verified email address: ${emailRefusalMessage(own.refused)}`));
    }
    const claimed = emailIn(await c.req.text());
    if (typeof claimed === 'string' && claimed.toLowerCase() !== own.email.toLowerCase()) {
      return problemResponse(c, substratError('permission_denied', 'join with the verified email address you signed in with'));
    }
    return next();
  });

  mountApi(app, async (c) => {
    // The identity directory says which tenant this login is in and which principal it is
    // there, so Cleo lands in the other tenant without this file knowing she is special.
    const caller = await login.caller(c.req.raw.headers);
    if (!caller) throw new HTTPException(401, { message: 'unauthorized' });
    return host.getScope(caller.principal, caller.tenantId, caller.scopeId);
  });

  return app;
}

/** The body's `email`, when it parses as JSON — otherwise the operation's parse says why not. */
function emailIn(body: string): unknown {
  try {
    return (JSON.parse(body) as { email?: unknown } | null)?.email;
  } catch {
    return undefined;
  }
}
