/**
 * The boot harness — node-only imports live HERE and never in module code.
 *
 * The host is built ONCE, on a persistent directory: a per-request or in-memory
 * host answers every request from an empty world, which every test that bypasses
 * HTTP would fail to notice.
 *
 * Authentication is an ordinary OIDC round-trip against whatever `OIDC_ISSUER` names —
 * locally `@substrat-run/dev-issuer`, a real provider you sign into by picking a name. It
 * replaced an `x-principal` header, which was an impersonation bypass and, in a vertical
 * with no worker, the ONLY login anyone reading this would ever see.
 *
 * The cast is persisted so restarts reuse the same principals — ULIDs minted afresh each
 * boot would orphan every list written before it — and the identity links are re-applied on
 * every boot, since `seed()` does not run again once `cast.json` exists.
 */
import { serve } from '@hono/node-server';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { platformActorId } from '@substrat-run/contracts';
import { API_DOCUMENT } from './api.js';
import { devLogin } from '@substrat-run/dev-issuer';
import { buildHost, linkDevPersonas, seed, type World } from './seed.js';
import { DEV_PROVIDER } from './personas.js';
import { mountApi } from './routes.js';

const DATA = process.env.DATA_DIR ?? '.data';
const CAST = join(DATA, 'cast.json');

async function boot() {
  mkdirSync(DATA, { recursive: true });
  const host = buildHost(DATA);

  // Seed once. A cast on disk means this world already exists.
  let world: World;
  if (existsSync(CAST)) {
    world = JSON.parse(readFileSync(CAST, 'utf8')) as World;
  } else {
    world = await seed(host);
    writeFileSync(CAST, JSON.stringify(world, null, 2));
  }

  // Re-branded on the way in: everything loaded from JSON crossed a serialization
  // boundary, so `world.staff` is a plain string until parsed.
  const staff = platformActorId.parse(world.staff);
  await linkDevPersonas(host, { ...world, staff });

  const app = new Hono();
  const login = devLogin({ directory: host.admin, actor: staff, provider: DEV_PROVIDER });

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
    return host.getScope(caller.principal, caller.tenantId, caller.scopeId);
  });

  const port = Number(process.env.PORT ?? 8878);
  serve({ fetch: app.fetch, port });
  process.stdout.write(`todo api on :${port} — auth: OIDC · ${login.issuer}\n`);
}

void boot();
