/**
 * The boot harness: host built ONCE on a persistent dir, seeded once, personas linked on
 * every boot, sign-in through the dev issuer (OIDC). No header ever names the caller.
 */
import { serve } from '@hono/node-server';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { platformActorId } from '@substrat-run/contracts';
import { devLogin, type DevCaller } from '@substrat-run/dev-issuer';
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
  // Every door goes through here, so an operation sees the address the issuer verified (K-61).
  const scopeOf = (caller: DevCaller) =>
    host.getScope(caller.principal, caller.tenantId, caller.scopeId, { verifiedEmail: caller.verifiedEmail });
  const app = new Hono();
  app.use('*', invocationLog());
  app.on(['GET', 'POST'], '/api/auth/*', (c) => login.handle(c.req.raw));
  app.get('/api/me', async (c) => {
    const caller = await login.caller(c.req.raw.headers);
    if (!caller) return c.json({ error: 'unauthorized' }, 401);
    // Signing in is joining: nobody types an address, and an open invitation becomes a share here.
    // An address the issuer did not verify stays out, so that person is signed in and not joined.
    if (caller.verifiedEmail && !joined.has(caller.principal)) {
      const stub = await scopeOf(caller);
      const admitted = await stub.invoke('lists/join', { displayName: caller.display }).then(
        () => true,
        () => false,
      );
      if (admitted) {
        await grantOwner(host, staff, { tenantId: caller.tenantId, scopeId: caller.scopeId }, caller.principal);
        joined.add(caller.principal);
      }
    }
    return c.json({ principal: caller.principal, display: caller.display });
  });
  mountApi(app, async (c) => {
    const caller = await login.caller(c.req.raw.headers);
    if (!caller) throw new HTTPException(401, { message: 'unauthorized' });
    return scopeOf(caller);
  });

  const port = Number(process.env.PORT ?? 8891);
  serve({ fetch: app.fetch, port });
  process.stdout.write(`shared-lists api on :${port} — issuer ${login.issuer}\n`);
}

void boot();
