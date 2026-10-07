import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from '@hono/node-server';
import { ulid } from '@substrat-run/kernel';
import { platformActorId } from '@substrat-run/contracts';
import { devLogin } from '@substrat-run/dev-issuer';
import { buildShopHost, seedShop, shopProvider, linkDevPersonas, type ShopWorld } from './index.js';
import { oidcAdapter, publicAuth, type AuthAdapter } from './auth-adapters.js';
import { shopApi } from './routes.js';

/**
 * Dev API server for the Kallkälla Kaffe demo. Deliberately thin: resolve the
 * principal (an OIDC session, or the anonymous browse-only fallback) → getScope
 * → invoke. Every route is a wrapper over an operation, and they live in `routes.ts`; this
 * file is the process around them — the data dir, the seed, the issuer, the port.
 *
 * Authentication is an ordinary OIDC round-trip against whatever `OIDC_ISSUER` names —
 * locally `@substrat-run/dev-issuer`, a real provider you sign into by picking a name.
 * The shop runs NO credential store: accounts, passwords, sign-up and reset all live at
 * the issuer, so moving to a real one is a change of `OIDC_ISSUER` and nothing else.
 *
 * The anonymous browse principal stays. It is not a credential — it is the storefront's
 * answer to "what may someone who has not signed in see", and the catalogue depends on it.
 */

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.data');
mkdirSync(dataDir, { recursive: true });

// Dev ports sit in a private 887x/527x block, clear of the Vite (5173) and
// Wrangler (8787) defaults that every other project on the machine also wants.
// Override without editing: PORT=… WEB_PORT=… ADMIN_PORT=… pnpm dev
//
// Two front ends, one API: the storefront (:5273) and the admin dashboard
// (:5274) are separate Vite apps that both proxy /api to this server. There is
// one kernel and one permission check behind both — the split is chrome and
// audience, never a second source of truth.
const PORT = Number(process.env.PORT ?? 8873);
const WEB_PORT = Number(process.env.WEB_PORT ?? 5273);
const ADMIN_PORT = Number(process.env.ADMIN_PORT ?? 5274);
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? `http://localhost:${WEB_PORT}`;
const ADMIN_ORIGIN = process.env.ADMIN_ORIGIN ?? `http://localhost:${ADMIN_PORT}`;

const host = buildShopHost(dataDir);
const world: ShopWorld = await seedShop(host, dataDir);

// The relying-party half. The cast's `sub`s are re-bound on every boot: `seedShop`
// short-circuits once `cast.json` exists, so a link written into a `.data` that was later
// cleared would otherwise never come back.
const staff = platformActorId.parse(ulid());
const login = devLogin({ directory: host.admin, actor: staff, provider: shopProvider('kallkalla') });
await linkDevPersonas(host, world);

// Mounted auth adapters, in precedence order: a real OIDC session wins; otherwise the
// anonymous fallback (browse-only). The public adapter must be last, and is
// unconditional — the storefront has no meaning without it.
const adapters: AuthAdapter[] = [oidcAdapter(login, host, world), publicAuth(world)];

const app = shopApi(host, adapters, (req) => login.handle(req));

serve({ fetch: app.fetch, port: PORT });
console.log(`Kallkälla shop demo API on http://localhost:${PORT} — data in ${dataDir}`);
console.log(`  auth: OIDC · ${login.issuer} (+ anonymous browse)`);
console.log(`  storefront: ${WEB_ORIGIN} · admin: ${ADMIN_ORIGIN}`);
