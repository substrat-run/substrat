/**
 * The HTTP app the dev server serves — built here, not in `server.ts`, so a test drives
 * the same wiring a browser does (the scenario suite never reaches it).
 */
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { substratError } from '@substrat-run/contracts';
import type { AuthSubject, DevLogin } from '@substrat-run/dev-issuer';
import type { ScopeHost, ScopeStub } from '@substrat-run/kernel';
import { emailRefusalMessage, identifyEmail, type EmailIdentityEnv } from '@substrat-run/oidc-rp';
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

  mountApi(app, async (c) => {
    // The identity directory says which tenant this login is in and which principal it is
    // there, so Cleo lands in the other tenant without this file knowing she is special.
    const caller = await login.caller(c.req.raw.headers);
    if (!caller) throw new HTTPException(401, { message: 'unauthorized' });
    const stub = await host.getScope(caller.principal, caller.tenantId, caller.scopeId);
    return joiningAsYourself(stub, env, () => login.subject(c.req.raw.headers));
  });

  return app;
}

/**
 * `todo/share-list` finds people by the address they joined with, so `todo/join` takes only
 * the session's own, issuer-verified address (#1359). The operation cannot see the session,
 * so the check wraps the stub every door invokes through — the HTTP route and the MCP tool
 * alike. Input without a string `email` is left to the operation's own parse.
 */
function joiningAsYourself(
  stub: ScopeStub,
  env: EmailIdentityEnv,
  subject: () => Promise<AuthSubject | null>,
): ScopeStub {
  return {
    tenantId: stub.tenantId,
    scopeId: stub.scopeId,
    ...(stub.subjectKind === undefined ? {} : { subjectKind: stub.subjectKind }),
    async invoke(operation, input, options) {
      const claimed = (input as { email?: unknown } | undefined)?.email;
      if (operation === 'todo/join' && typeof claimed === 'string') {
        const who = await subject();
        const own = identifyEmail(env, { id: who?.sub ?? '', email: who?.email ?? undefined, emailVerified: who?.emailVerified });
        if (own.email === null) {
          throw substratError('permission_denied', `joining needs a verified email address: ${emailRefusalMessage(own.refused)}`);
        }
        if (claimed.toLowerCase() !== own.email.toLowerCase()) {
          throw substratError('permission_denied', 'join with the verified email address you signed in with');
        }
        // Stored as the issuer spells it, which is the spelling a share will be addressed to.
        return stub.invoke(operation, { ...input, email: own.email } as typeof input, options);
      }
      return stub.invoke(operation, input, options);
    },
  };
}
