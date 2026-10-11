/**
 * The boot harness — node-only imports live HERE and never in module code.
 *
 * The host is built ONCE, on a persistent directory: a per-request or in-memory
 * host answers every request from an empty world, which every test that bypasses
 * HTTP would fail to notice.
 *
 * Authentication is an ordinary OIDC round-trip, wired in `./app.ts`. It replaced an `x-principal` header, which was an impersonation bypass and, in a vertical
 * with no worker, the ONLY login anyone reading this would ever see.
 *
 * The cast is persisted so restarts reuse the same principals — ULIDs minted afresh each
 * boot would orphan every list written before it — and the identity links are re-applied on
 * every boot, since `seed()` does not run again once `cast.json` exists.
 */
import { serve } from '@hono/node-server';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { platformActorId } from '@substrat-run/contracts';
import { devLogin } from '@substrat-run/dev-issuer';
import { createApp } from './app.js';
import { buildHost, linkDevPersonas, reconcileOwnerGrants, seed, type World } from './seed.js';
import { DEV_PROVIDER } from './personas.js';

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
  // #2071: a cast seeded before a key was added to OWNER_GRANTS receives it here.
  await reconcileOwnerGrants(host, { ...world, staff });

  const login = devLogin({ directory: host.admin, actor: staff, provider: DEV_PROVIDER });
  const app = createApp({ host, login, env: process.env });

  const port = Number(process.env.PORT ?? 8878);
  serve({ fetch: app.fetch, port });
  process.stdout.write(`todo api on :${port} — auth: OIDC · ${login.issuer}\n`);
}

void boot();
