/**
 * The boot harness: host built ONCE on a persistent dir, seeded once, personas linked on
 * every boot, sign-in through the dev issuer (OIDC). No header ever names the caller.
 */
import { serve } from '@hono/node-server';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { platformActorId, substratError } from '@substrat-run/contracts';
import { devLogin, type AuthSubject } from '@substrat-run/dev-issuer';
import type { ScopeStub } from '@substrat-run/kernel';
import { emailRefusalMessage, identifyEmail, type EmailIdentityEnv } from '@substrat-run/oidc-rp';
import { invocationLog } from '@substrat-run/vertical-host';
import { buildHost, grantOwner, linkDevPersonas, reconcileOwnerGrants, seed, type World } from './seed.js';
import { DEV_PROVIDER } from './personas.js';
import { mountApi } from './routes.js';

const DATA = process.env.DATA_DIR ?? '.data';
const CAST = join(DATA, 'cast.json');

async function boot() {
  mkdirSync(DATA, { recursive: true });
  const host = buildHost(DATA);

  let world: World;
  if (existsSync(CAST)) {
    world = JSON.parse(readFileSync(CAST, 'utf8')) as World;
  } else {
    world = await seed(host);
    writeFileSync(CAST, JSON.stringify(world, null, 2));
  }
  const staff = platformActorId.parse(world.staff);
  await linkDevPersonas(host, { ...world, staff });
  await reconcileOwnerGrants(host, { ...world, staff });

  const ISSUER_PORT = Number(process.env.ISSUER_PORT ?? 8879);
  const login = devLogin({
    directory: host.admin,
    actor: staff,
    provider: DEV_PROVIDER,
    issuer: process.env.OIDC_ISSUER ?? `http://localhost:${ISSUER_PORT}`,
  });

  const joined = new Set<string>();
  const app = new Hono();
  app.use('*', invocationLog());
  app.on(['GET', 'POST'], '/api/auth/*', (c) => login.handle(c.req.raw));
  app.get('/api/me', async (c) => {
    const caller = await login.caller(c.req.raw.headers);
    if (!caller) return c.json({ error: 'unauthorized' }, 401);
    return c.json({ principal: caller.principal, display: caller.display });
  });
  mountApi(app, async (c) => {
    const caller = await login.caller(c.req.raw.headers);
    if (!caller) throw new HTTPException(401, { message: 'unauthorized' });
    const stub = joiningAsYourself(
      await host.getScope(caller.principal, caller.tenantId, caller.scopeId),
      process.env,
      () => login.subject(c.req.raw.headers),
    );
    // Joining is signing in: nobody types an address, and an open invitation becomes a share here.
    if (caller.email && !joined.has(caller.principal)) {
      await stub.invoke('lists/join', { email: caller.email, displayName: caller.display });
      await grantOwner(host, staff, { tenantId: caller.tenantId, scopeId: caller.scopeId }, caller.principal);
      joined.add(caller.principal);
    }
    return stub;
  });

  const port = Number(process.env.PORT ?? 8891);
  serve({ fetch: app.fetch, port });
  process.stdout.write(`shared-lists api on :${port} — issuer ${login.issuer}\n`);
}

/**
 * `lists/share-list` finds people by the address they joined with, so `lists/join` takes only
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
      if (operation === 'lists/join' && typeof claimed === 'string') {
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

void boot();
