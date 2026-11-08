/**
 * The HTTP app the dev server serves — built here, not in `server.ts`, so a test drives
 * the same wiring a browser does (the scenario suite never reaches it).
 */
import { Hono } from 'hono';
import { invocationLog } from '@substrat-run/vertical-host';
import { HTTPException } from 'hono/http-exception';
import type { DevCaller, DevLogin } from '@substrat-run/dev-issuer';
import type { ScopeHost, ScopeStubOptions } from '@substrat-run/kernel';
import { API_DOCUMENT } from './api.js';
import { mountApi } from './routes.js';

export interface AppOptions {
  host: Pick<ScopeHost, 'getScope'>;
  login: Pick<DevLogin, 'handle' | 'caller'>;
  /** After a person's first join here: what the host owes them, such as their owner grant. */
  onJoined?: (caller: DevCaller) => Promise<void>;
  /**
   * Where the mail an invite queues is written, as soon as the call commits: `server.ts` hands in
   * adapter-sqlite's `devMailOutbox`, named here only by the stub options it adds.
   */
  outbox?: { kick(caller: DevCaller): Pick<ScopeStubOptions, 'onPlatformRequests'> };
}

export function createApp({ host, login, onJoined, outbox }: AppOptions): Hono {
  const app = new Hono();
  const joined = new Set<string>();
  // Every door goes through here, so an operation sees the address the issuer verified (K-61).
  const scopeOf = (caller: DevCaller) =>
    host.getScope(caller.principal, caller.tenantId, caller.scopeId, {
      verifiedEmail: caller.verifiedEmail,
      ...outbox?.kick(caller),
    });
  // The request's stamp: an id on every response (`x-substrat-request-id`) and, under
  // `substrat dev`, the HTTP half of its trace. FIRST, so it wraps every route below. Bare on
  // purpose: no router fronts this server, so there is nothing to verify and no line to write.
  app.use('*', invocationLog());

  // The relying-party endpoints. Accounts and passwords live at the issuer; this vertical
  // has no credential store and hosts no sign-up.
  app.on(['GET', 'POST'], '/api/auth/*', (c) => login.handle(c.req.raw));

  /** Who is signed in — the shape the app's header renders, or 401. */
  app.get('/api/me', async (c) => {
    const caller = await login.caller(c.req.raw.headers);
    if (!caller) return c.json({ error: 'unauthorized' }, 401);
    // Signing in is joining: nobody types an address, and an open invitation becomes a share here.
    // An address the issuer did not verify stays out, so that person is signed in and not joined.
    if (caller.verifiedEmail && !joined.has(caller.principal)) {
      const stub = await scopeOf(caller);
      const admitted = await stub.invoke('todo/join', { displayName: caller.display }).then(
        () => true,
        () => false,
      );
      if (admitted) {
        await onJoined?.(caller);
        joined.add(caller.principal);
      }
    }
    return c.json({ principal: caller.principal, display: caller.display, ...(caller.email ? { email: caller.email } : {}) });
  });

  // The document this vertical's own operations describe, served from its own
  // origin. Computed once at boot from the same declarations the routes below are
  // derived from — never read from the checked-in `openapi.json`, which exists so
  // a surface change shows up in a PR diff (api-surface.md §2.4) rather than to be
  // served. The platform's `/api/docs` renders this same document, which `routes.ts`
  // hands `mountOperations`.
  app.get('/openapi.json', (c) => c.json(API_DOCUMENT));

  mountApi(app, async (c) => {
    // The identity directory says which tenant this login is in and which principal it is
    // there, so Cleo lands in the other tenant without this file knowing she is special.
    const caller = await login.caller(c.req.raw.headers);
    if (!caller) throw new HTTPException(401, { message: 'unauthorized' });
    return scopeOf(caller);
  });

  return app;
}
