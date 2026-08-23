import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { PermissionDenied, startPlatformSweeper, ulid, type FetchLike, type ScopeStub } from '@substrat-run/kernel';
import {
  ScriveMock,
  SCRIVE_TESTBED,
  SCRIVE_CALLBACK_ROUTE,
  handleScriveCallback,
  sweepScriveReconciliations,
} from '@substrat-run/connector-scrive';
import { devLogin, type DevCaller } from '@substrat-run/dev-issuer';
import { DEV_PROVIDER } from './personas.js';
import { platformActorId, principalId, type PrincipalId, type ScopeId, type TenantId } from '@substrat-run/contracts';
import { buildDemoHost, seedDemo, type DemoWorld, type ScriveConfig } from './index.js';
import { EMPLOYEE_SELF } from './provision.js';
import { API, API_DOCUMENT } from './api.js';
import { DOCS_HTML } from './docs.js';

/**
 * Dev API server for the Meridian demo. Deliberately thin: resolve the caller →
 * getScope → invoke. No business logic here; every route is a wrapper over an
 * operation, and the kernel enforces the permission on every op regardless of how the
 * route reached it.
 *
 * OIDC-only (oidc-only-demos.md) and, since the dev issuer, with NO dev branch: this
 * server authenticates exactly the way the deployed worker does. `/api/auth/*` is the
 * relying-party flow, a session cookie carries the login, and the identity directory maps
 * the issuer's `sub` to a principal. What stood here was an `x-principal` header and a
 * `CAST` table holding each persona's role, country and employee id — an impersonation
 * bypass, plus a set of facts the hosted app had to derive from `hr/whoami` instead. Both
 * are gone; `/api/me` now answers from `hr/whoami` in both entrypoints.
 *
 * Secure by default matters more here than it did as a demo: this is a template now
 * (D-33), and a template is COPIED. A default that impersonates is one people carry into
 * production without noticing they opted into anything.
 *
 * The Vite proxy must not set `changeOrigin`: this server derives its OIDC `redirect_uri`
 * from the forwarded Host header, which is what lands the callback back on the SPA.
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
 *
 * The webhook ingress (#96) rides the same opt-ins. `SCRIVE_CALLBACK_BASE` names
 * the public base Scrive can reach this server on (for the real testbed that is
 * a tunnel URL; unset ⇒ poll-only, exactly as before). Mock mode defaults it to
 * this server's own localhost, and the mock DELIVERS the callback with a real
 * HTTP POST — the full loop, sign → provider callback → capability URL verified
 * → reconcile, runs offline.
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
      config: {
        secret,
        baseUrl: process.env.SCRIVE_BASE_URL ?? SCRIVE_TESTBED,
        ...(process.env.SCRIVE_CALLBACK_BASE
          ? { callbackBaseUrl: process.env.SCRIVE_CALLBACK_BASE }
          : {}),
      },
      egress: (globalThis as unknown as { fetch: FetchLike }).fetch,
      mock: null,
    };
  }
  if (process.env.MERIDIAN_SCRIVE_MOCK === '1') {
    // The mock plays the provider's delivery too: a signing event POSTs the
    // capability URL the connector registered, against this very server.
    const mock = new ScriveMock({
      onCallback: async (cb) => {
        const res = await fetch(cb.url, { method: 'POST' });
        console.log(`[scrive-mock] callback → ${res.status} (${cb.documentId} ${cb.status})`);
      },
    });
    return {
      config: {
        secret: { clientId: 'ci', clientSecret: 'cs', tokenId: 'ti', tokenSecret: 'ts' },
        fetch: mock.fetch,
        callbackBaseUrl: process.env.SCRIVE_CALLBACK_BASE ?? `http://localhost:${PORT}`,
      },
      egress: mock.fetch,
      mock,
    };
  }
  return null;
}

const scrive = resolveScrive();
const host = buildDemoHost(dataDir, scrive?.config);
const world: DemoWorld = await seedDemo(host, dataDir, scrive?.config.secret);

/**
 * The relying party. Personas each carry their own (tenant, scope) — there is a second
 * company for the cross-tenant beat, and a Spanish scope beside the Swedish one — and both
 * come out of the identity link the seed wrote, not out of a table here.
 */
const login = devLogin({ directory: host.admin, actor: platformActorId.parse(ulid()), provider: DEV_PROVIDER });

async function persona(c: Context): Promise<DevCaller> {
  const caller = await login.caller(c.req.raw.headers);
  // 401, not 403 — and the distinction now matters. Before the dev issuer this server had
  // no signed-out state at all, so "nobody" could be reported as a refusal without anyone
  // noticing; the SPA keys its sign-in screen on 401 (app/src/data.ts), and a 403 here left
  // a signed-out user staring at an error instead of a login button.
  if (!caller) throw new HTTPException(401, { message: 'unauthorized' });
  return caller;
}

async function stub(c: Context): Promise<ScopeStub> {
  const p = await persona(c);
  return host.getScope(p.principal, p.tenantId, p.scopeId);
}

const app = new Hono();

app.onError((err, c) => {
  // An explicit status wins — 401 for "nobody", which is not a refusal.
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  if (err instanceof PermissionDenied) return c.json({ error: err.message }, 403);
  const m = err instanceof Error ? err.message : String(err);
  if (/permission denied/.test(m)) return c.json({ error: m }, 403);
  if (/not found|unknown scope/.test(m)) return c.json({ error: m }, 404);
  return c.json({ error: m }, 400);
});

// The relying-party endpoints — login, callback, logout. The same flow the worker runs;
// accounts, passwords and sign-up live at the issuer.
app.on(['GET', 'POST'], '/api/auth/*', (c) => login.handle(c.req.raw));

/**
 * Who am I — `{ key, display, role, country, employeeId }`, byte-identical to the worker's.
 * The principal comes from the auth seam; role, country and the linked employee record come
 * from the scope's own data via `hr/whoami`, which is why the employee app centres itself
 * correctly for a real hosted login and not only for a seeded persona.
 */
app.get('/api/me', async (c) => {
  const p = await persona(c);
  const scope = await host.getScope(p.principal, p.tenantId, p.scopeId);
  const who = (await scope.invoke('hr/whoami', undefined)) as {
    role: string;
    country: 'SE' | 'ES';
    employeeId: string | null;
  };
  return c.json({ key: p.principal, display: p.display, role: who.role, country: who.country, employeeId: who.employeeId });
});

/**
 * Mirror of the worker's `grantEmployeeSelf` (see worker.ts) on the SQLite dev host: when an
 * employee is created with a login attached, issue that principal the self-service grants
 * narrowed to their own record via the audited `host.admin.grant`. Keeps `pnpm … dev` behaving
 * like the deployed worker — an employee you register can actually report time.
 */
async function grantEmployeeSelf(p: DevCaller, result: unknown): Promise<void> {
  const row = result as { id?: string; principal_ref?: string | null } | null;
  if (!row?.id || !row.principal_ref) return;
  // Only a real principal is a grantable subject, so skip anything else rather than throw.
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
// Dev posture: the docs are open like every other dev route, and Scalar's try-it rides
// the session cookie the browser already holds. The Scalar renderer is served from the
// pinned package, never a CDN.
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
// `signed`. Mock mode is the gate, and it is gate enough: it replaces the Scrive egress
// with an in-process fake, so a run that has it cannot be talking to a real provider.
// (It used to also require ALLOW_DEV_HEADER, which no longer exists here.)
if (scrive?.mock) {
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

// The webhook ingress (#96): Scrive POSTs a capability URL on signing events, and
// this verifies the minted token against the dispatch ledger and runs the same
// reconcile the sweep runs — push collapses the poll's latency, never replaces it.
// Unauthenticated by design (the token IS the authentication; Scrive signs nothing),
// mounted only when a provider is wired, and the body is never read.
if (scrive) {
  const s = scrive;
  app.post(SCRIVE_CALLBACK_ROUTE, async (c) => {
    const ref = c.req.param();
    try {
      const outcome = await handleScriveCallback(host, ref, {
        fetch: s.egress,
        baseUrl: s.config.baseUrl,
      });
      if (!outcome.accepted) {
        // One uniform answer for every rejection; the WHY stays server-side.
        console.log(`[scrive-callback] rejected (${outcome.reason})`);
        return c.json({ error: 'not found' }, 404);
      }
      const { recorded, complete, documentStatus } = outcome.result;
      console.log(
        `[scrive-callback] ${ref.instanceId}: recorded ${recorded.length}, status ${documentStatus}${complete ? ', complete' : ''}`,
      );
      return c.json({ ok: true });
    } catch (err) {
      // Verified but the reconcile failed (provider hiccup, store contention):
      // 500 so the provider retries; the poll floor covers it regardless.
      console.error('[scrive-callback] reconcile failed', err);
      return c.json({ error: 'reconcile failed' }, 500);
    }
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
if (scrive?.config.callbackBaseUrl) {
  console.log(`  scrive callbacks        ${scrive.config.callbackBaseUrl}/hooks/scrive/…`);
}
console.log(`  data                    ${dataDir}\n`);
