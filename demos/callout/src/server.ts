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
import { devLogin } from '@substrat-run/dev-issuer';
import { buildDemoHost, seedDemo } from './index.js';
import { mountApi } from './routes.js';
import { DEV_PROVIDER } from './personas.js';
import type { DevCaller } from '@substrat-run/dev-issuer';

/**
 * Dev API server for the FSM demo. Deliberately thin: resolve the caller → getScope → invoke.
 * No business logic here; every route is a wrapper over an operation, and the kernel enforces
 * the permission on every op regardless of how the route reached it.
 *
 * OIDC-only (oidc-only-demos.md), and — since the dev issuer — with NO dev branch at all.
 * This server authenticates exactly the way the deployed worker does: the relying-party
 * provider owns `/api/auth/*`, a session cookie carries the login, and the identity directory
 * maps the issuer's `sub` to a principal. What used to sit here was an `x-principal` header
 * and a `CAST` table — an impersonation bypass, plus a second auth path the deployed vertical
 * never runs. Both are gone: locally the issuer is `@substrat-run/dev-issuer` (a real OP whose
 * only shortcut is that you pick a name instead of typing a password), and switching issuers
 * is a change of `OIDC_ISSUER`, not a change of code.
 *
 * The one thing to know about the proxy: the SPA is served by Vite on WEB_PORT and forwards
 * `/api` here WITHOUT rewriting the Host header, so the origin this server derives — and
 * therefore the `redirect_uri` it registers with the issuer — is the browser's origin, not
 * this port. That is what lands the OIDC callback back on the SPA. Setting `changeOrigin` on
 * that proxy would break login.
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
await seedDemo(host, dataDir);

// The local platform actor (control-plane.md §6). Directory reads below are stamped with it;
// `resolveIdentity` itself is the unaudited machine path, `listIdentityTenants` is not.
const staffActor = platformActorId.parse(ulid());

/**
 * The relying party — the same flow the deployed worker runs, pointed at whatever issuer
 * `OIDC_ISSUER` names. Locally that is the dev issuer `pnpm dev` starts; nothing here knows
 * or cares which, and that is the point.
 */
const login = devLogin({ directory: host.admin, actor: staffActor, provider: DEV_PROVIDER });

/**
 * Who is calling — the production two-step, run locally: the issuer asserts a `sub`, the
 * identity directory says which principal that is and where they live. The persona's node
 * comes out of the link, so Mallory still resolves into the second company and every
 * cross-tenant beat still runs — without this file holding a table of who is who.
 */
async function callerFor(c: Context): Promise<DevCaller> {
  const caller = await login.caller(c.req.raw.headers);
  if (!caller) throw new HTTPException(401, { message: 'unauthorized' });
  return caller;
}

const app = new Hono();

// The relying-party endpoints — login, callback, logout. Identical to the worker's, because
// it is the same provider underneath; accounts, passwords and sign-up live at the issuer.
app.on(['GET', 'POST'], '/api/auth/*', (c) => login.handle(c.req.raw));

/**
 * The resolved identity behind the current request — `{ principal, display, role, via }`, the
 * shape the SPA renders its chrome from. Mirrors the worker's `/api/me` exactly; the SPA now
 * has one auth path because both backends answer this.
 */
app.get('/api/me', async (c) => {
  const caller = await callerFor(c);
  const scope = await host.getScope(caller.principal, caller.tenantId, caller.scopeId);
  const who = await scope.invoke<{ role: string }>('callout/whoami', undefined);
  return c.json({ principal: caller.principal, display: caller.display, role: who.role, via: 'oidc' });
});

// The connect seam: with CONTROL_PLANE_URL set, this vertical registers into a separately-run
// shared control plane and gates every request on its authoritative lifecycle. Without it, the
// vertical embeds its own control plane on cpPort, co-located in this process (the local default).
const cpUrl = process.env.CONTROL_PLANE_URL;
let cpClient: ControlPlaneClient | undefined;

/** Resolve the caller → their linked node → a scope stub. Gates on the remote directory when connected. */
async function stub(c: Context): Promise<ScopeStub> {
  const caller = await callerFor(c);
  if (cpClient) {
    // Remote lifecycle gate: the shared control plane is the authority. A suspend there (via
    // the console) fails this request closed, across the boundary.
    try {
      await cpClient.assertScopeActive(caller.tenantId, caller.scopeId);
    } catch (e) {
      throw new HTTPException(403, { message: e instanceof ControlPlaneError ? e.message : String(e) });
    }
  }
  return host.getScope(caller.principal, caller.tenantId, caller.scopeId);
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
  `    auth   OIDC · ${login.issuer}`,
  '',
];
console.log(lines.join('\n'));
