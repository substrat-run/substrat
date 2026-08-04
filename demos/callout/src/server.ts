import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  platformActorId,
  type PrincipalId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { ulid, type ScopeStub } from '@substrat-run/kernel';
import {
  ControlPlaneClient,
  ControlPlaneError,
  createControlPlaneApi,
  UNSAFE_devPlatformActorAuth,
} from '@substrat-run/control-plane-api';
import { buildDemoHost, seedDemo, type DemoWorld } from './index.js';
import { mountApi } from './routes.js';
import {
  devHeaderAdapter,
  resolvePrincipal,
  type AuthAdapter,
} from './auth-adapters.js';

/**
 * Dev API server for the FSM demo. Deliberately thin: pick the dev principal from the
 * `x-principal` header → getScope → invoke. No business logic here; every route is a wrapper
 * over an operation, and the kernel enforces the permission on every op regardless of how the
 * route reached it.
 *
 * OIDC-only (oidc-only-demos.md): the vertical runs no credential store, so this dev server
 * hosts NO accounts and NO `/api/auth/*`. Local dev authenticates with the `x-principal`
 * persona picker — an impersonation bypass by design, mounted ONLY when ALLOW_DEV_HEADER=true.
 * A real login is the OIDC round-trip, exercised via the worker (`wrangler dev`) against a
 * running issuer. There is deliberately NO `/api/me` here: its absence is how the SPA detects
 * the dev backend and shows the persona picker (app/src/api.ts `me()` → 404 → header mode).
 *
 * The shared control plane rides the SAME SqliteScopeHost on its own port (co-located for
 * local dev): one process, one SQLite dir, so a suspend in the console fails this vertical's
 * next operation closed. In production these are separate deployments; the co-location here is
 * a local-dev convenience, not the topology.
 */

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.data');
mkdirSync(dataDir, { recursive: true });

// Dev ports sit in a private 887x/527x block, clear of the Vite (5173) and Wrangler (8787)
// defaults. Override without editing: PORT=… WEB_PORT=… pnpm callout-demo dev
const port = Number(process.env.PORT ?? 8871);
const webPort = Number(process.env.WEB_PORT ?? 5271);
// The shared control plane's port (the console's dev proxy default).
const cpPort = Number(process.env.CP_PORT ?? 8788);

const host = buildDemoHost(dataDir);
const world: DemoWorld = await seedDemo(host, dataDir);

/**
 * The demo cast — each persona carries its OWN (tenant, scope), so switching to Mallory lands
 * in t2/s2 (a different tenant) and proves the isolation. Portal personas (Berit, Styrbjörn)
 * hold entity-narrowed customer grants seeded in `seedDemo`. The role is a UI hint the app
 * uses to pick chrome; the kernel still enforces the real permissions on every op.
 */
interface Persona {
  key: string;
  name: string;
  role: string;
  principal: PrincipalId;
  tenantId: TenantId;
  scopeId: ScopeId;
}

const CAST: Persona[] = [
  { key: 'anna', name: 'Anna (kontor)', role: 'office-admin', principal: world.anna, tenantId: world.t1, scopeId: world.s1 },
  { key: 'harald', name: 'Harald (tekniker)', role: 'technician', principal: world.harald, tenantId: world.t1, scopeId: world.s1 },
  { key: 'berit', name: 'Berit (portal, BRF Grunden)', role: 'portal', principal: world.berit, tenantId: world.t1, scopeId: world.s1 },
  { key: 'styrbjorn', name: 'Styrbjörn (portal, Kontorshotellet)', role: 'portal', principal: world.styrbjorn, tenantId: world.t1, scopeId: world.s1 },
  { key: 'mallory', name: 'Mallory (annan firma!)', role: 'office-admin', principal: world.mallory, tenantId: world.t2, scopeId: world.s2 },
];

/**
 * The dev header only if explicitly opted in. A template teaches by example, and a copied
 * template inherits its defaults — so the impersonation header stays OFF unless
 * ALLOW_DEV_HEADER=true (which `pnpm dev` sets for local use).
 */
const adapters: AuthAdapter[] = [];
if (process.env.ALLOW_DEV_HEADER === 'true') adapters.push(devHeaderAdapter());

/**
 * Resolve the caller to a persona: the dev-header adapter names a principal (the app's picker
 * sends the persona's principal id), which we map back to its (tenant, scope). The header may
 * also name a persona KEY directly, kept because it is the ergonomic half of the demo and
 * gated with the rest of the header. Nobody resolved → 401.
 */
function persona(c: Context): Promise<Persona> {
  return (async () => {
    const headers = c.req.raw.headers;
    const via = await resolvePrincipal(adapters, headers);
    if (via) {
      const found = CAST.find((p) => p.principal === via.principal);
      if (found) return found;
    }
    if (process.env.ALLOW_DEV_HEADER === 'true') {
      const key = headers.get('x-principal');
      const byKey = key ? CAST.find((p) => p.key === key) : undefined;
      if (byKey) return byKey;
    }
    throw new HTTPException(401, { message: 'unauthorized' });
  })();
}

const app = new Hono();

// The dev persona picker: the app switches personas by setting the x-principal header. Keyed
// by persona key, `{ name, role, principal }` per member — the shape app/src/api.ts expects.
app.get('/api/cast', (c) =>
  c.json(Object.fromEntries(CAST.map((p) => [p.key, { name: p.name, role: p.role, principal: p.principal }]))),
);

// The connect seam: with CONTROL_PLANE_URL set, this vertical registers into a separately-run
// shared control plane and gates every request on its authoritative lifecycle. Without it, the
// vertical embeds its own control plane on cpPort, co-located in this process (the local default).
const cpUrl = process.env.CONTROL_PLANE_URL;
let cpClient: ControlPlaneClient | undefined;

/** Resolve the caller → the persona's node → a scope stub. Gates on the remote directory when connected. */
async function stub(c: Context): Promise<ScopeStub> {
  const p = await persona(c);
  if (cpClient) {
    // Remote lifecycle gate: the shared control plane is the authority. A suspend there (via
    // the console) fails this request closed, across the boundary.
    try {
      await cpClient.assertScopeActive(p.tenantId, p.scopeId);
    } catch (e) {
      throw new HTTPException(403, { message: e instanceof ControlPlaneError ? e.message : String(e) });
    }
  }
  return host.getScope(p.principal, p.tenantId, p.scopeId);
}

// The whole data API — shared with the Cloudflare Worker (src/routes.ts), which also installs
// the shared fail-closed error handler.
mountApi(app, stub);

if (cpUrl) {
  // Connected: mirror the seeded directory into the shared control plane so the console
  // (pointed there) sees this vertical's tenants and scopes; the gate above then enforces its
  // lifecycle. Roles stay LOCAL — role writes are not on the control-plane HTTP surface.
  const registrar = platformActorId.parse(ulid());
  cpClient = new ControlPlaneClient({ baseUrl: cpUrl, actor: registrar });
  const tenants = await host.admin.listTenants(registrar);
  const scopes = await host.admin.listScopes(registrar);
  // Everything below is idempotent, so retry the whole registration while the control plane is
  // still starting up (concurrently launches both at once).
  for (let attempt = 1; ; attempt++) {
    try {
      for (const t of tenants) {
        await cpClient.createTenant({ id: t.id, slug: t.slug, name: t.name });
        for (const e of await host.admin.listEntitlements(registrar, t.id)) {
          await cpClient.grantEntitlement(t.id, e.entitlementKey, {
            expiresAt: e.expiresAt,
            quota: e.quota,
            plan: e.plan,
          });
        }
      }
      for (const s of scopes) {
        await cpClient.provisionScope({
          tenantId: s.tenantId,
          scopeId: s.id,
          slug: s.slug,
          kind: s.kind,
          name: s.name,
          vertical: s.vertical,
        });
        await cpClient.activateScope(s.tenantId, s.id);
      }
      break;
    } catch (e) {
      if (e instanceof ControlPlaneError && e.status === 0 && attempt < 40) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      throw e;
    }
  }
} else {
  // Co-located: the shared control plane over the same `host`, on cpPort. UNSAFE dev-actor
  // auth is the only posture a local stub may take (control-plane.md §6); it binds localhost only.
  const controlPlane = createControlPlaneApi({ host, authenticate: UNSAFE_devPlatformActorAuth() });
  serve({ fetch: controlPlane.fetch, port: cpPort, hostname: '127.0.0.1' });
}

serve({ fetch: app.fetch, port });

// One consolidated banner instead of scattered log lines. The console and app URLs are only
// shown under the root stack (SUBSTRAT_STACK=1) — running this server alone doesn't start those
// Vite processes. The console dev port is a fixed convention (apps/console/vite.config.ts).
const inStack = process.env.SUBSTRAT_STACK === '1';
const consolePort = Number(process.env.CONSOLE_PORT ?? 5272);
const subtitle = cpUrl ? 'connected to a shared control plane' : 'one process, one SQLite dir';
const cpLine = cpUrl
  ? `      control plane         ${cpUrl}  (shared, connected)`
  : `      control plane API     http://localhost:${cpPort}`;
const lines = [
  '',
  `  substrat · ${inStack ? 'local stack' : 'Callout API'} — ${subtitle}`,
  '  ' + '─'.repeat(52),
  ...(inStack
    ? [
        `    ▶ Console (open this)   http://localhost:${consolePort}`,
        `    ▶ Portal — Callout    http://localhost:${webPort}`,
        '',
      ]
    : []),
  `      vertical API          http://localhost:${port}`,
  cpLine,
  '  ' + '─'.repeat(52),
  `    data   ${dataDir}`,
  `    auth   ${adapters.length ? adapters.map((a) => a.id).join(', ') : 'none (set ALLOW_DEV_HEADER=true)'}`,
  '',
];
console.log(lines.join('\n'));
