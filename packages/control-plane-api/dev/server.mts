/**
 * Local dev server for the control-plane API — the thing the console points at.
 *
 * Deliberately NOT in `src/`: it is harness code, node-only, and outside the
 * published `files`. The package itself stays web-standard so the same router
 * mounts inside a Worker (control-plane.md §5.5).
 *
 * It binds 127.0.0.1 and runs the UNSAFE dev actor stub, which is the only
 * posture §6 permits: "real auth gates EXPOSING the console, not BUILDING it —
 * nothing with cross-tenant reach goes anywhere non-local on a stub."
 */
import { serve } from '@hono/node-server';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import { platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import type { DirectoryDump } from '@substrat-run/contracts';
import {
  createControlPlaneApi,
  createWfpUploader,
  DEV_ACTOR_HEADER,
  sessionPlatformAuth,
  staffAllowlist,
  UNSAFE_devPlatformActorAuth,
  type DirectoryBackupStore,
  type PlatformActorAuth,
} from '../src/index.js';
import {
  buildStaffAuth,
  migrateStaffAuth,
  staffSessionReader,
  type StaffAuth,
} from './staff-auth.mjs';

const dir = process.env.SUBSTRAT_DIR ?? mkdtempSync(join(tmpdir(), 'substrat-cp-'));
const host = new SqliteScopeHost({ dir });
const staff = platformActorId.parse(ulid());

// A small fleet, so the console has something with real shape to render:
// several tenants, a suspended one (whose scopes fail closed by cascade), a
// couple of verticals, and every scope status the badge mapping covers.
const world = [
  { slug: 'acme', name: 'Acme Fastigheter', status: 'active', skus: ['workorder', 'invoicing'],
    scopes: [
      // A live install with a canonical hostname — the "Serving" badge + a real portal link.
      { slug: 'brf-vasastan', kind: 'brf', name: 'Brf Vasastan', vertical: 'housing', status: 'active',
        hostname: 'brf-vasastan-acme.eu.substrat.run' },
      { slug: 'brf-sjostaden', kind: 'brf', name: 'Brf Sjöstaden', vertical: 'housing', status: 'active' },
      // Archived YET still bound — the #500 near-miss: it reads "Serving" while archived, and
      // its reap is the guarded unbind-&-reap, not a silent wipe.
      { slug: 'brf-eken', kind: 'brf', name: 'Brf Eken', vertical: 'housing', status: 'archived',
        hostname: 'brf-eken-acme.eu.substrat.run' },
    ] },
  { slug: 'nordan', name: 'Nordan Bygg', status: 'active', skus: ['workorder'],
    scopes: [
      { slug: 'hq', kind: 'branch', name: 'Nordan Bygg HQ', vertical: 'fsm', status: 'active' },
      { slug: 'syd', kind: 'branch', name: 'Nordan Bygg Syd', vertical: 'fsm', status: 'suspended' },
    ] },
  // Suspended tenant: its scopes stay stored-active but every one fails closed.
  // This is the cascade the console renders as "via tenant".
  { slug: 'kiosk', name: 'Kiosk Kedjan', status: 'suspended', skus: ['shop'],
    scopes: [{ slug: 'main', kind: 'brand', name: 'Kiosk Main', vertical: 'shop', status: 'active' }] },
] as const;

// CP_SKIP_SEED starts the control plane EMPTY — used by the connected topology
// (`pnpm dev:connected`), where a real vertical registers its own tenants/scopes
// over HTTP and the fake fleet below would only be noise.
if (!process.env.CP_SKIP_SEED)
for (const t of world) {
  const tid = tenantId.parse(ulid());
  await host.admin.createTenant(staff, { id: tid, slug: t.slug, name: t.name });
  for (const key of t.skus) await host.admin.grantEntitlement(staff, tid, key);
  for (const s of t.scopes) {
    const sid = scopeId.parse(ulid());
    await host.provisionScope(staff, {
      tenantId: tid, scopeId: sid, slug: s.slug, kind: s.kind, name: s.name,
      vertical: s.vertical, jurisdiction: 'eu',
    });
    // A provisioned scope lands `provisioning` (K-31); the fake fleet wants live
    // scopes, so activate before any suspend/archive — those transitions are
    // illegal from `provisioning`.
    await host.admin.activateScope(staff, tid, sid);
    if (s.status === 'suspended') await host.admin.suspendScope(staff, tid, sid);
    if (s.status === 'archived') await host.admin.archiveScope(staff, tid, sid);
    // Bind a hostname AFTER any archive, so an archived-yet-bound scope exists to drive
    // the reap guard's UI. `active` so it also renders a working portal link.
    if ('hostname' in s && s.hostname) {
      await host.admin.bindHostname(staff, {
        hostname: s.hostname, tenantId: tid, scopeId: sid, surface: 'app', region: null, canonical: true,
      });
      await host.admin.setHostnameStatus(staff, s.hostname, 'active');
    }
  }
  // Suspend the tenant last, so its scopes provision first.
  if (t.status === 'suspended') await host.admin.setTenantStatus(staff, tid, 'suspended');
}

// A role, then the same role redefined — which is the whole point of the
// permission checkpoint. `defineRole` captures before/after, so the second call
// is what the console's "Needs review" tab renders as a real diff: site-manager
// silently gaining invoice:read is exactly the change a human is meant to catch.
const [firstTenant] = await host.admin.listTenants(staff);
if (firstTenant) {
  await host.admin.defineRole(staff, firstTenant.id, {
    key: 'site-manager',
    permissions: ['workorder:read', 'workorder:create', 'workorder:close'],
    source: 'vertical',
  });
  await host.admin.defineRole(staff, firstTenant.id, {
    key: 'site-manager',
    permissions: ['workorder:read', 'workorder:create', 'workorder:close', 'invoice:read'],
    source: 'vertical',
  });
  // A second source, so the Roles tab's filter has something to distinguish.
  // Both of these are code-declared — an engine's manifest and a vertical's
  // constants. Nothing seeds an operator-created role because nothing can make
  // one: role writes are not on the HTTP surface, and `source` has no value for it.
  await host.admin.defineRole(staff, firstTenant.id, {
    key: 'technician',
    permissions: ['workorder:read', 'workorder:close'],
    source: '@substrat-run/engine-workorder',
  });
  // Per-tenant stores (#301/#473), so the tenant's Stores card and a scope's Cloudflare
  // card render with real ledger shape — the inventory an operator follows to the right
  // database. Minted directly here because provisioning them for real needs a pushed
  // vertical that DECLARES them, which the fake fleet has no bundle for.
  await host.provisionTenantStore(staff, {
    tenantId: firstTenant.id,
    vertical: 'housing',
    binding: 'AUTH_DB',
  });
  await host.provisionBlobStore(staff, {
    tenantId: firstTenant.id,
    vertical: 'housing',
    binding: 'FILES',
  });
}

const port = Number(process.env.PORT ?? 8788);
const origin = `http://127.0.0.1:${port}`;
// The console's Vite dev origins — Better Auth checks these on sign-in.
const consoleOrigins = ['http://localhost:5272', 'http://127.0.0.1:5272'];

// Real staff auth (§6): Better Auth, unless CP_UNSAFE_AUTH=1 flips back to the
// header stub for quick header-based testing. The allowlist is who counts as
// staff and under which actor id; Better Auth only proves the email. Both map the
// operator onto the same `staff` actor that seeded the fleet, so the audit trail
// is coherent in the dev world.
const STAFF_EMAIL = 'markus@substrat.run';
const STAFF_PASSWORD = 'substrat123';

let authenticate: PlatformActorAuth = UNSAFE_devPlatformActorAuth();
let staffAuth: StaffAuth | undefined;
if (process.env.CP_UNSAFE_AUTH !== '1') {
  staffAuth = buildStaffAuth(dir, origin, [...consoleOrigins, origin]);
  await migrateStaffAuth(staffAuth);
  try {
    await staffAuth.api.signUpEmail({
      body: { email: STAFF_EMAIL, password: STAFF_PASSWORD, name: 'Markus' },
    });
  } catch {
    // Already seeded — signing up an existing email throws; fine.
  }
  const sessionAuth = sessionPlatformAuth(
    staffSessionReader(staffAuth),
    staffAllowlist([{ email: STAFF_EMAIL, actor: staff }]),
  );
  // The console authenticates as STAFF (a Better Auth session). A connected
  // vertical authenticates as a SERVICE (registering its scopes), which is a
  // different problem — open decision 2. Locally the dev-actor header stands in
  // for that service credential; in production a vertical uses a real one and this
  // header path is gone. Session first (the console sends no header), header
  // fallback (the vertical sends no session); neither → 401.
  const serviceAuth = UNSAFE_devPlatformActorAuth();
  authenticate = async (req) => (await sessionAuth(req)) ?? serviceAuth(req);
}

// One outer app: Better Auth owns /auth/*, the control-plane router owns the rest
// (behind `authenticate`). The console reaches /auth/* via its proxy's /api strip.
// Real WfP uploader when CF creds are in the env, so `substrat push` can be driven
// end-to-end against a real dispatch namespace locally. Absent ⇒ the deploy route 501s.
const cfToken = process.env.CF_API_TOKEN;
const cfAccount = process.env.CF_ACCOUNT_ID;
const deployVertical =
  cfToken && cfAccount
    ? createWfpUploader({
        accountId: cfAccount,
        namespace: process.env.DISPATCH_NAMESPACE ?? 'substrat-verticals',
        apiToken: cfToken,
      })
    : undefined;
// An in-memory directory-backup store (#40), so the console's Recovery tab is drivable
// locally. Deliberately not persisted: dev restarts with an empty store, which is also the
// state worth seeing — "no copy has been taken yet" is what a freshly deployed control
// plane shows before its first sweep.
const directoryCopies = new Map<string, DirectoryDump>();
const directoryBackups: DirectoryBackupStore = {
  put: async ({ dump }) => {
    directoryCopies.set(dump.capturedAt, dump);
    return { capturedAt: dump.capturedAt, size: JSON.stringify(dump).length, tables: dump.tables.length };
  },
  list: async () =>
    [...directoryCopies.values()]
      .map((d) => ({ capturedAt: d.capturedAt, size: JSON.stringify(d).length, tables: d.tables.length }))
      .sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1)),
  get: async ({ capturedAt }) => directoryCopies.get(capturedAt) ?? null,
  delete: async ({ capturedAt }) => void directoryCopies.delete(capturedAt),
};
// Where the console's refs resolve, so its Cloudflare links are drivable locally. A real
// account when one is in the env (the same var the WfP uploader reads); otherwise a
// placeholder, because the fake fleet above has fake refs anyway — the point locally is
// that the links RENDER and carry the right ids, not that they resolve.
const platformRuntime = {
  provider: 'cloudflare' as const,
  accountId: cfAccount ?? 'dev-account',
  dispatchNamespace: process.env.DISPATCH_NAMESPACE ?? 'substrat-verticals',
};
const cpApp = createControlPlaneApi({
  host,
  authenticate,
  deployVertical,
  directoryBackups,
  platformRuntime,
});
const app = new Hono();
if (staffAuth) app.on(['GET', 'POST'], '/auth/*', (c) => staffAuth!.handler(c.req.raw));
app.route('/', cpApp);

serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  console.log(`control-plane API  http://127.0.0.1:${info.port}`);
  console.log(`directory          ${dir}`);
  if (staffAuth) {
    console.log(`staff auth         Better Auth — sign in as ${STAFF_EMAIL} / ${STAFF_PASSWORD}`);
  } else {
    console.log(`dev actor          ${DEV_ACTOR_HEADER}: ${staff}  (UNSAFE)`);
    console.log(`\n  curl -s -H '${DEV_ACTOR_HEADER}: ${staff}' http://127.0.0.1:${info.port}/tenants\n`);
  }
});
