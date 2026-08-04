import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { PermissionDenied, startPlatformSweeper, ulid, type FetchLike, type ScopeStub } from '@substrat-run/kernel';
import {
  ScriveMock,
  SCRIVE_TESTBED,
  sweepScriveReconciliations,
} from '@substrat-run/connector-scrive';
import {
  devHeaderAdapter,
  resolvePrincipal,
  type AuthAdapter,
} from './auth-adapters.js';
import { platformActorId, principalId, type PrincipalId, type ScopeId, type TenantId } from '@substrat-run/contracts';
import { buildDemoHost, seedDemo, type DemoWorld, type ScriveConfig } from './index.js';
import { EMPLOYEE_SELF } from './provision.js';
import { API, API_DOCUMENT } from './api.js';
import { DOCS_HTML } from './docs.js';

/**
 * Dev API server for the Meridian demo. Deliberately thin: pick the dev
 * principal from the `x-principal` header → getScope → invoke. No business
 * logic here; every route is a wrapper over an operation, and the kernel
 * enforces the permission on every op regardless of how the route reached it.
 *
 * OIDC-only (oidc-only-demos.md): the vertical runs no credential store, so this dev
 * server hosts NO accounts and NO `/api/auth/*`. Local dev authenticates with the
 * `x-principal` persona picker — an impersonation bypass by design, mounted ONLY when
 * ALLOW_DEV_HEADER=true. A real login is the OIDC round-trip, exercised via the worker
 * (`wrangler dev`) against a running `demos/auth-server` issuer.
 *
 * Secure by default matters more here than it did as a demo: this is a template
 * now (D-33), and a template is COPIED. A default that impersonates is one people
 * carry into production without noticing they opted into anything.
 */

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.data');
mkdirSync(dataDir, { recursive: true });

// Dev ports in the private 887x/527x block. The employee app is :5275, the
// (future) admin web app :5276, both proxying /api to this server on :8875.
const PORT = Number(process.env.PORT ?? 8875);
const WEB_PORT = Number(process.env.WEB_PORT ?? 5275);

/**
 * Scrive wiring, opt-in from the environment. Three modes:
 *   - real testbed: SCRIVE_CLIENT_ID/SECRET + SCRIVE_TOKEN_ID/SECRET set → global fetch
 *   - mock:         MERIDIAN_SCRIVE_MOCK=1 → ScriveMock, offline, with a dev sign endpoint
 *   - off (default): no connection, no sweeper — the contract sits pending, honest
 *     without a provider.
 * `mock` is returned when ScriveMock backs the egress, so the dev route can drive it.
 */
function resolveScrive(): { config: ScriveConfig; egress: FetchLike; mock: ScriveMock | null } | null {
  const { SCRIVE_CLIENT_ID, SCRIVE_CLIENT_SECRET, SCRIVE_TOKEN_ID, SCRIVE_TOKEN_SECRET } = process.env;
  if (SCRIVE_CLIENT_ID && SCRIVE_CLIENT_SECRET && SCRIVE_TOKEN_ID && SCRIVE_TOKEN_SECRET) {
    const secret = {
      clientId: SCRIVE_CLIENT_ID,
      clientSecret: SCRIVE_CLIENT_SECRET,
      tokenId: SCRIVE_TOKEN_ID,
      tokenSecret: SCRIVE_TOKEN_SECRET,
    };
    // Real testbed: the runtime's global fetch is the egress (host default), so
    // pass no `fetch` and hand the sweeper the same global.
    return {
      config: { secret, baseUrl: process.env.SCRIVE_BASE_URL ?? SCRIVE_TESTBED },
      egress: (globalThis as unknown as { fetch: FetchLike }).fetch,
      mock: null,
    };
  }
  if (process.env.MERIDIAN_SCRIVE_MOCK === '1') {
    const mock = new ScriveMock();
    return {
      config: { secret: { clientId: 'ci', clientSecret: 'cs', tokenId: 'ti', tokenSecret: 'ts' }, fetch: mock.fetch },
      egress: mock.fetch,
      mock,
    };
  }
  return null;
}

const scrive = resolveScrive();
const host = buildDemoHost(dataDir, scrive?.config);
const world: DemoWorld = await seedDemo(host, dataDir, scrive?.config.secret);

interface Persona {
  key: string;
  display: string;
  role: string;
  country: 'SE' | 'ES';
  principal: PrincipalId;
  tenantId: TenantId;
  scopeId: ScopeId;
  employeeId: string | null;
}

const CAST: Persona[] = [
  { key: 'elin', display: 'Elin Ek', role: 'employee', country: 'SE', principal: world.elin, tenantId: world.t1, scopeId: world.sSe, employeeId: world.elinEmpId ?? null },
  { key: 'pablo', display: 'Pablo Ruiz', role: 'employee', country: 'ES', principal: world.pablo, tenantId: world.t1, scopeId: world.sEs, employeeId: world.pabloEmpId ?? null },
  { key: 'mats', display: 'Mats Lund (team lead)', role: 'manager', country: 'SE', principal: world.mats, tenantId: world.t1, scopeId: world.sSe, employeeId: world.matsEmpId ?? null },
  { key: 'hedda', display: 'Hedda (HR admin)', role: 'hr-admin', country: 'SE', principal: world.hedda, tenantId: world.t1, scopeId: world.sSe, employeeId: null },
  { key: 'petra', display: 'Petra (payroll)', role: 'payroll', country: 'SE', principal: world.petra, tenantId: world.t1, scopeId: world.sSe, employeeId: null },
  { key: 'mallory', display: 'Mallory (other company!)', role: 'attacker', country: 'SE', principal: world.mallory, tenantId: world.t2, scopeId: world.s2, employeeId: null },
];

/**
 * Real auth first; the dev header only if explicitly opted in.
 *
 * A template teaches by example, so the example is a session — not a header that
 * names whoever it likes. The header stays for local iteration and stays OFF by
 * default, because a copied template inherits its defaults.
 *
 * Meridian's personas each carry their own (tenant, scope) — there is a second
 * company for the cross-tenant beat — so resolution walks the cast to find whose
 * principal a session maps to. A login unknown to every company resolves to
 * nobody, and reads the same as unauthenticated.
 */
const adapters: AuthAdapter[] = [];
if (process.env.ALLOW_DEV_HEADER === 'true') adapters.push(devHeaderAdapter());

async function persona(c: Context): Promise<Persona> {
  const headers = c.req.raw.headers;
  const viaAdapters = await resolvePrincipal(adapters, headers);
  if (viaAdapters) {
    const found = CAST.find((p) => p.principal === viaAdapters.principal);
    if (found) return found;
  }
  // The dev header may also name a persona KEY, which is what the app's picker
  // sends. Kept because it is the ergonomic half of the demo, and gated with the
  // rest of the header.
  if (process.env.ALLOW_DEV_HEADER === 'true') {
    const key = headers.get('x-principal');
    const byKey = key ? CAST.find((p) => p.key === key) : undefined;
    if (byKey) return byKey;
  }
  throw new PermissionDenied('not authenticated');
}

async function stub(c: Context): Promise<ScopeStub> {
  const p = await persona(c);
  return host.getScope(p.principal, p.tenantId, p.scopeId);
}

const app = new Hono();

app.onError((err, c) => {
  if (err instanceof PermissionDenied) return c.json({ error: err.message }, 403);
  const m = err instanceof Error ? err.message : String(err);
  if (/permission denied/.test(m)) return c.json({ error: m }, 403);
  if (/not found|unknown scope/.test(m)) return c.json({ error: m }, 404);
  return c.json({ error: m }, 400);
});

// The dev persona picker + "who am I" — the app switches personas by setting the
// x-principal header. employeeId is what an employee app centres itself on.
app.get('/api/cast', (c) =>
  c.json(CAST.map(({ key, display, role, country, employeeId }) => ({ key, display, role, country, employeeId }))),
);
app.get('/api/me', async (c) => {
  const p = await persona(c);
  return c.json({ key: p.key, display: p.display, role: p.role, country: p.country, employeeId: p.employeeId });
});

/**
 * Mirror of the worker's `grantEmployeeSelf` (see worker.ts) on the SQLite dev host: when an
 * employee is created with a login attached, issue that principal the self-service grants
 * narrowed to their own record via the audited `host.admin.grant`. Keeps `pnpm … dev` behaving
 * like the deployed worker — an employee you register can actually report time.
 */
async function grantEmployeeSelf(p: Persona, result: unknown): Promise<void> {
  const row = result as { id?: string; principal_ref?: string | null } | null;
  if (!row?.id || !row.principal_ref) return;
  // The dev `/api/me` returns a persona KEY, not a principal id; only a real principal is a
  // grantable subject, so skip the persona-key case rather than throw on parse.
  const subject = principalId.safeParse(row.principal_ref);
  if (!subject.success) return;
  const staff = platformActorId.parse(ulid());
  for (const permission of EMPLOYEE_SELF) {
    await host.admin.grant(staff, {
      principalId: subject.data,
      permission,
      node: { tenantId: p.tenantId, scopeId: p.scopeId },
      entity: { entityType: 'employee', entityId: row.id },
      grantedBy: p.principal,
    });
  }
}

// Generic invoke: the kernel checks permissions inside every operation, so a
// generic route is exactly as safe as 18 explicit ones — and far less code.
app.post('/api/invoke', async (c) => {
  const { op, input } = await c.req.json<{ op: string; input?: unknown }>();
  const p = await persona(c);
  const result = (await (await host.getScope(p.principal, p.tenantId, p.scopeId)).invoke(op, input)) ?? null;
  if (op === 'hr/create-employee') await grantEmployeeSelf(p, result);
  return c.json(result);
});

// The documented invoke surface + the API reference (design/api-surface.md).
// Dev posture: the docs are open like every other dev route — the x-principal
// persona picker is the auth, and Scalar's try-it sends whatever header the
// caller sets. The Scalar renderer is served from the pinned package, never a CDN.
app.post('/api/op/*', async (c) => {
  const name = decodeURIComponent(new URL(c.req.url).pathname.slice('/api/op/'.length));
  if (!(name in API)) return c.json({ error: `unknown operation: ${name}` }, 404);
  const body = await c.req.text();
  const p = await persona(c);
  const result = (await (await host.getScope(p.principal, p.tenantId, p.scopeId)).invoke(name, body ? JSON.parse(body) : undefined)) ?? null;
  if (name === 'hr/create-employee') await grantEmployeeSelf(p, result);
  return c.json(result);
});
app.get('/openapi.json', (c) => c.json(API_DOCUMENT));
app.get('/api/docs', (c) => c.html(DOCS_HTML));
const scalarJs = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', 'node_modules', '@scalar', 'api-reference', 'dist', 'browser', 'standalone.js',
);
app.get('/assets/scalar-api-reference.js', (c) =>
  c.body(readFileSync(scalarJs, 'utf8'), 200, { 'content-type': 'text/javascript; charset=utf-8' }),
);

// Dev-only: simulate the provider-side signature so the poll loop is observable
// with the mock (a real testbed signs in the browser instead). Signs every party
// of every mock document; the next sweep records them and the contract goes
// `signed`. Gated on the dev header AND mock mode, so it never exists on a real run.
if (scrive?.mock && process.env.ALLOW_DEV_HEADER === 'true') {
  const mock = scrive.mock;
  app.post('/api/dev/scrive-sign', (c) => {
    const at = new Date().toISOString();
    let signed = 0;
    for (const doc of mock.documents.values()) {
      doc.parties.forEach((_p, i) => {
        mock.sign(doc.id, i, at);
        signed += 1;
      });
    }
    return c.json({ signed, documents: mock.documents.size });
  });
}

// No /api/auth/* here: the vertical runs no credential store (oidc-only-demos.md). Dev auth is
// the x-principal persona picker; real login is the OIDC round-trip via the worker + issuer.

// The scheduler's call site. One timer drives the whole platform sweep:
//   - #96: poll Scrive so a completed signature is recorded back with no caller;
//   - #383: run Meridian's own recurring schedules (`hr/expire-stale-requests`),
//     under a system actor, on every live scope.
// The driver and both units of work live in the kernel/connector/module; this is
// the one line a deployment adds. Non-overlapping by construction. Runs even
// without Scrive — the schedule half needs no connection.
{
  const pollMs = Number(process.env.SCRIVE_POLL_MS ?? 15_000);
  startPlatformSweeper(host, {
    actor: platformActorId.parse(ulid()),
    fetch: scrive?.egress ?? (globalThis.fetch as unknown as FetchLike),
    sweepers: scrive ? { scrive: sweepScriveReconciliations } : {},
    intervalMs: pollMs,
    onPass: (o) => {
      if ('error' in o) console.error('[platform-sweep]', o.error);
      else if (o.errors.length) console.error('[platform-sweep]', o.errors.length, 'error(s)', o.errors);
      else {
        if (o.connectionsSwept) console.log(`[platform-sweep] polled ${o.connectionsSwept} connection(s)`);
        if (o.schedules?.fired) console.log(`[platform-sweep] ran ${o.schedules.fired} schedule(s)`);
      }
    },
  });
  console.log(
    `  platform sweeper        every ${pollMs / 1000}s (schedules${scrive ? ` + scrive ${scrive.mock ? '(ScriveMock)' : '(testbed)'}` : ''})`,
  );
}

serve({ fetch: app.fetch, port: PORT });
console.log(`\n  Meridian (HR) demo API  http://localhost:${PORT}`);
console.log(`  employee app            http://localhost:${WEB_PORT}`);
console.log(`  data                    ${dataDir}\n`);
