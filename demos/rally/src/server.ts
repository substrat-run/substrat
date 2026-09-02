import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { platformActorId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { devLogin } from '@substrat-run/dev-issuer';
import { buildRallyHost, seedRally, type RallyWorld } from './index.js';
import { createRallyApp } from './routes.js';
import { linkRallyLogins } from './seed.js';
import { DEV_PROVIDER } from './personas.js';

/**
 * Dev API server for the RallyPoint demo — bootstrap only. The routes live in
 * app.ts so the same app can be driven by tests without a socket.
 *
 * Two web apps sit in front of this one API — the player app (:5277) and the
 * manager console (:5278). The split is chrome and audience, never a second
 * source of truth.
 *
 * Authentication is an ordinary OIDC round-trip against whatever `OIDC_ISSUER` names —
 * locally `@substrat-run/dev-issuer`, a real provider you sign into by picking a name.
 * The club runs no credential store, and there is no `x-principal` header any more.
 */

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.data');
mkdirSync(dataDir, { recursive: true });

const host = buildRallyHost(dataDir);
const world: RallyWorld = await seedRally(host, dataDir);

// Private 887x/527x block — see each app's vite.config.ts. PORT moves the API,
// PLAYER_PORT / CONSOLE_PORT move the two web ends.
const PORT = Number(process.env.PORT ?? 8877);
const PLAYER_PORT = Number(process.env.PLAYER_PORT ?? 5277);
const CONSOLE_PORT = Number(process.env.CONSOLE_PORT ?? 5278);

const staff = platformActorId.parse(ulid());
const login = devLogin({ directory: host.admin, actor: staff, provider: DEV_PROVIDER });
await linkRallyLogins(host, world);

const app = new Hono();
// The relying-party endpoints. Accounts and passwords live at the issuer.
app.on(['GET', 'POST'], '/api/auth/*', (c) => login.handle(c.req.raw));
app.route('/', createRallyApp(host, world, login));

serve({ fetch: app.fetch, port: PORT });
console.log(`\n  RallyPoint demo API   http://localhost:${PORT}`);
console.log(`  player app            http://localhost:${PLAYER_PORT}`);
console.log(`  manager console       http://localhost:${CONSOLE_PORT}`);
console.log(`  auth                  OIDC · ${login.issuer}`);
console.log(`  data in ${dataDir}\n`);
