/**
 * The boot harness — node-only imports live HERE and never in module code.
 *
 * The host is built ONCE, on a persistent directory: a per-request or in-memory
 * host answers every request from an empty world, which every test that bypasses
 * HTTP would fail to notice.
 *
 * Dev authentication is the `x-principal` persona picker. The cast is persisted
 * so restarts reuse the same principals — ULIDs minted afresh each boot would
 * orphan every list written before it.
 */
import { serve } from '@hono/node-server';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { buildHost, seed, type World } from './seed.js';
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

  const app = new Hono();
  // Re-branded on the way in: everything loaded from JSON crossed a
  // serialization boundary, so it is a plain string until parsed.
  const cast = [world.ada, world.bjorn, world.cleo];
  mountApi(app, async (c) => {
    const header = c.req.header('x-principal');
    if (!header) throw new HTTPException(401, { message: 'x-principal header required' });
    // Matched on the address's local part, not the display name: HTTP header
    // values are latin-1, so `Björn` arrives mojibake and would never match.
    const key = header.toLowerCase();
    const who = cast.find(
      (p) => p.email.split('@')[0] === key || p.principal === header,
    );
    if (!who) throw new HTTPException(401, { message: `unknown principal: ${header}` });
    const inOwnTenant = who.email === world.cleo.email;
    return host.getScope(
      principalId.parse(who.principal),
      tenantId.parse(inOwnTenant ? world.otherTenant : world.tenant),
      scopeId.parse(inOwnTenant ? world.otherScope : world.scope),
    );
  });

  const port = Number(process.env.PORT ?? 8878);
  serve({ fetch: app.fetch, port });
  process.stdout.write(`todo api on :${port} — personas: ${cast.map((p) => p.name).join(', ')}\n`);
}

void boot();
