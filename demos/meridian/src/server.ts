import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { Context } from 'hono';
import Database from 'better-sqlite3';
import { PermissionDenied, startPlatformSweeper, ulid, type FetchLike, type ScopeStub } from '@substrat-run/kernel';
import {
  ScriveMock,
  SCRIVE_TESTBED,
  sweepScriveReconciliations,
} from '@substrat-run/connector-scrive';
import { buildAuthNode, migrateAuth } from './auth-node.js';
import {
  devHeaderAdapter,
  resolvePrincipal,
  type AuthAdapter,
} from './auth-adapters.js';
import { platformActorId, type PrincipalId, type ScopeId, type TenantId } from '@substrat-run/contracts';
import { buildDemoHost, seedDemo, type DemoWorld, type ScriveConfig } from './index.js';
import { API, API_DOCUMENT } from './api.js';
import { DOCS_HTML } from './docs.js';

/**
 * Dev API server for the Meridian demo. Deliberately thin: pick the dev
 * principal from the `x-principal` header → getScope → invoke. No business
 * logic here; every route is a wrapper over an operation, and the kernel
 * enforces the permission on every op regardless of how the route reached it.
 *
 * There is no Better Auth here yet. The `x-principal` picker is an
 * impersonation bypass by design — anyone naming a persona becomes it — so it is
 * mounted ONLY when ALLOW_DEV_HEADER=true, matching Callout's posture.
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

const auth = buildAuthNode(dataDir, `http://localhost:${PORT}`, [
  `http://localhost:${PORT}`,
  `http://localhost:${WEB_PORT}`,
]);
await migrateAuth(auth);

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
  const session = await sessionPersona(headers);
  if (session) return session;

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

/** A Better Auth session → the persona that login is bound to, in whichever company. */
async function sessionPersona(headers: Headers): Promise<Persona | null> {
  const s = await auth.api.getSession({ headers });
  if (!s?.user) return null;
  for (const p of CAST) {
    const mapped = await host.admin.resolveIdentity(p.tenantId, 'better-auth', s.user.id);
    if (mapped && mapped.principal === p.principal) return p;
  }
  return null;
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

// Generic invoke: the kernel checks permissions inside every operation, so a
// generic route is exactly as safe as 18 explicit ones — and far less code.
app.post('/api/invoke', async (c) => {
  const { op, input } = await c.req.json<{ op: string; input?: unknown }>();
  return c.json((await (await stub(c)).invoke(op, input)) ?? null);
});

// The documented invoke surface + the API reference (design/api-surface.md).
// Dev posture: the docs are open like every other dev route — the x-principal
// persona picker is the auth, and Scalar's try-it sends whatever header the
// caller sets. The Scalar renderer is served from the pinned package, never a CDN.
app.post('/api/op/*', async (c) => {
  const name = decodeURIComponent(new URL(c.req.url).pathname.slice('/api/op/'.length));
  if (!(name in API)) return c.json({ error: `unknown operation: ${name}` }, 404);
  const body = await c.req.text();
  return c.json((await (await stub(c)).invoke(name, body ? JSON.parse(body) : undefined)) ?? null);
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

// Better Auth owns /api/auth/*. Mounted last so it cannot shadow a demo route.
app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));

await seedPersonaLogins();

// The scheduler's call site (#96): drive the poll on a timer so a signature
// completed at Scrive is recorded back into the scope without anyone asking. This
// is the one line a deployment adds; the driver and reconcile live in the kernel
// and the connector. Non-overlapping by construction.
if (scrive) {
  const pollMs = Number(process.env.SCRIVE_POLL_MS ?? 15_000);
  startPlatformSweeper(host, {
    actor: platformActorId.parse(ulid()),
    fetch: scrive.egress,
    sweepers: { scrive: sweepScriveReconciliations },
    intervalMs: pollMs,
    onPass: (o) => {
      if ('error' in o) console.error('[scrive-sweep]', o.error);
      else if (o.errors.length) console.error('[scrive-sweep]', o.errors.length, 'error(s)', o.errors);
      else if (o.connectionsSwept) console.log(`[scrive-sweep] polled ${o.connectionsSwept} connection(s)`);
    },
  });
  console.log(`  scrive sweeper          every ${pollMs / 1000}s ${scrive.mock ? '(ScriveMock)' : '(testbed)'}`);
}

serve({ fetch: app.fetch, port: PORT });
console.log(`\n  Meridian (HR) demo API  http://localhost:${PORT}`);
console.log(`  employee app            http://localhost:${WEB_PORT}`);
console.log(`  data                    ${dataDir}\n`);

/**
 * Demo logins for the cast, so the template runs with a real session out of the
 * box rather than only with the dev header.
 *
 * Idempotent on both sides: sign-up throws when the email exists, in which case
 * the id is read back, and an already-linked identity is skipped. The two stores
 * have independent lifecycles, so neither may assume the other is empty.
 */
async function seedPersonaLogins(): Promise<void> {
  const staff = platformActorId.parse(ulid());
  const db = new Database(join(dataDir, 'better-auth.sqlite'), { readonly: true });
  try {
    for (const p of CAST) {
      const email = `${p.key}@meridian.test`;
      let externalId: string | undefined;
      try {
        externalId = (
          await auth.api.signUpEmail({
            body: { email, password: 'meridian-demo', name: p.display },
          })
        ).user.id;
      } catch {
        externalId = (db.prepare('SELECT id FROM user WHERE email = ?').get(email) as
          | { id: string }
          | undefined)?.id;
      }
      if (!externalId) continue;
      if (await host.admin.resolveIdentity(p.tenantId, 'better-auth', externalId)) continue;
      await host.admin.linkIdentity(staff, {
        provider: 'better-auth',
        externalId,
        principal: p.principal,
        tenantId: p.tenantId,
        scopeId: p.scopeId,
      });
    }
  } finally {
    db.close();
  }
}
