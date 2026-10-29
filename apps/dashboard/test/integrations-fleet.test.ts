import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { MODULES, provisionDashboard } from '../src/index.js';

/**
 * A bureau's Fortnox fleet (#1267 follow-up): one app, one connection per client company.
 *
 * #1267 keyed the plane's Fortnox connections on the company, so a second consent is a
 * second row. What these routes add is the ability to ADDRESS one row of that fleet —
 * list them all, inspect one, disconnect one — and the property that matters is that the
 * id only ever selects among this app's own live rows for the named provider. An id from
 * another vertical or another provider is a 404, never a reach into someone else's row.
 *
 * Driven through the worker with the seams `app-processes.test.ts` uses; the plane behind
 * the service binding is an in-memory directory that honours the `vertical` filter, so
 * the cross-vertical case is decided by the route and not by the fake.
 */
const shared = vi.hoisted(() => ({ host: null as unknown }));

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
vi.mock('@substrat-run/adapter-cloudflare', () => ({
  defineScopeDO: () => class {},
  defineScopeSweeperDO: () => class {},
  SCOPE_SWEEPER_NAME: 'scope-sweeper',
  ControlPlaneDO: class {},
  CloudflareScopeHost: class {
    constructor() {
      const target = shared.host as object;
      return new Proxy(target, {
        get(t, key) {
          if (key === 'registerModule' || key === 'registerExecutor') return () => undefined;
          const v = Reflect.get(t, key) as unknown;
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
        },
      });
    }
  },
}));
vi.mock('@substrat-run/oidc-rp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@substrat-run/oidc-rp')>()),
  mountOidcRoutes: () => undefined,
  verifySession: async (_env: unknown, token: string | undefined) => (token ? { id: token } : null),
}));

const workerModule = '../src/worker.js';
const { default: app } = (await import(/* @vite-ignore */ workerModule)) as {
  default: { request(path: string, init: RequestInit, env: unknown): Response | Promise<Response> };
};

const VERTICAL = 'acme/books';
/** A connector this app's vertical declares (vertical-connectors.md §7.2), and nothing `requires`. */
const DOC_CONNECTOR = {
  provider: 'acme.docbox',
  label: 'docbox archive',
  description: 'Files signed documents into the archive.',
  fields: [
    { key: 'apiKey', label: 'API key', secret: true },
    { key: 'archive', label: 'Archive id', secret: false, placeholder: 'arc-123' },
  ],
  grants: ['books:file-document'],
  events: [],
  sweeps: true,
  binds: false,
  dispatches: false,
};
const staff = platformActorId.parse(ulid());

interface Row {
  id: string;
  tenantId: string;
  vertical: string;
  provider: string;
  label: string;
  status: 'active' | 'error' | 'expired' | 'revoked';
  externalAccountRef: string | null;
  scopes: string[];
  expiresAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  createdAt: string;
}

describe('a Fortnox fleet on one app (#1267 follow-up)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const tenant = tenantId.parse(ulid());
  const dashScope = scopeId.parse(ulid());
  const appScope = scopeId.parse(ulid());
  let rows: Row[];
  let revoked: string[];
  let verified: string[];
  // What the plane's intent journal answers; the default `[]` is a clean journal.
  let intents: unknown[];
  // What the connect door sent the plane's upsert (vertical-connectors.md §7.2).
  let upserts: Record<string, unknown>[];
  let refuseUpsert: boolean;
  let planeCalls: string[];
  // What this vertical's latest push declares; a test empties it to model a push that dropped one.
  let declared: (typeof DOC_CONNECTOR)[];
  let env: Record<string, unknown>;

  const row = (over: Partial<Row>): Row => ({
    id: ulid(),
    tenantId: tenant,
    vertical: VERTICAL,
    provider: 'fortnox',
    label: 'Fortnox',
    status: 'active',
    externalAccountRef: null,
    scopes: [],
    expiresAt: null,
    lastOkAt: null,
    lastError: null,
    lastErrorAt: null,
    createdAt: '2026-10-01T09:00:00.000Z',
    ...over,
  });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-integrations-fleet-'));
    host = new SqliteScopeHost({ dir });
    shared.host = host;
    for (const m of MODULES) host.registerModule(m);
    revoked = [];
    verified = [];
    intents = [];
    upserts = [];
    refuseUpsert = false;
    planeCalls = [];
    declared = [DOC_CONNECTOR];

    const owner = principalId.parse(ulid());
    const node = await provisionDashboard(host, { tenantId: tenant, scopeId: dashScope, owner, slug: 'bureau', name: 'Bureau' });
    await host.admin.registerIdentityPool(staff, { provider: 'authhero', topology: 'central', tenantId: null });
    await host.admin.linkIdentity(staff, {
      provider: 'authhero', externalId: 'sub-owner', principal: owner, tenantId: tenant, scopeId: dashScope,
    });
    const dash = await host.getScope(node.principal, node.tenantId, node.scopeId);
    await dash.invoke('dashboard/provision-app', { appScopeId: appScope, verticalSlug: VERTICAL, name: 'Books' });

    // ULIDs sort by time, so minting in sequence fixes "newest first".
    const first = row({ externalAccountRef: '111111', label: 'Alfa AB' });
    const second = row({ externalAccountRef: '222222', label: 'Beta AB', status: 'error', lastError: 'HTTP 401' });
    const third = row({ externalAccountRef: '333333', label: 'Gamma AB' });
    rows = [
      first,
      second,
      third,
      row({ externalAccountRef: '444444', label: 'Gone AB', status: 'revoked' }),
      // The same provider under another vertical — not this app's to see or touch.
      row({ vertical: 'acme/other', externalAccountRef: '555555', label: 'Other AB' }),
      // Another provider on this app's own vertical.
      row({ provider: 'scrive', label: 'Scrive' }),
    ];

    env = {
      SCOPE: {},
      CONTROL_PLANE: {},
      SESSION_SECRET: 'test-session-secret',
      CP_SERVICE_TOKEN: 'service-token',
      CONTROL_PLANE_SVC: {
        fetch: async (url: string | URL | Request, init?: RequestInit) => {
          const u = new URL(String(url));
          const path = u.pathname.replace(/^\/api/, '');
          planeCalls.push(path);
          const method = init?.method ?? 'GET';
          if (path === '/tenant-tokens') return Response.json({ token: 'tenant-token' });
          if (path === '/verticals') {
            return Response.json({
              entries: [
                { slug: VERTICAL, name: 'Books', source: 'registry', ownerTenant: null, listed: true, requires: ['fortnox'], connectors: declared },
                // Another vertical's own connector: not a door on this app.
                {
                  slug: 'acme/other', name: 'Other', source: 'registry', ownerTenant: null, listed: true,
                  connectors: [{ ...DOC_CONNECTOR, provider: 'acme.other', label: 'Other archive' }],
                },
              ],
              nextCursor: null,
            });
          }
          if (path === `/tenants/${tenant}/connections` && method === 'POST') {
            upserts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
            if (refuseUpsert) return Response.json({ detail: 'Provider refused the credential', probe: { ok: false, refused: true, accountRef: null, accountLabel: null, facts: [], error: 'Invalid credential' } }, { status: 422 });
            return Response.json({ connectionId: ulid(), created: true, granted: [] });
          }
          if (path === `/tenants/${tenant}/connections` && method === 'GET') {
            const vertical = u.searchParams.get('vertical');
            return Response.json(rows.filter((r) => r.status !== 'revoked' && (!vertical || r.vertical === vertical)));
          }
          const one = path.match(new RegExp(`^/tenants/${tenant}/connections/([^/]+)(/[a-z]+)?$`));
          if (one) {
            const [, id, tail] = one;
            if (!tail && method === 'DELETE') {
              revoked.push(id!);
              for (const r of rows) if (r.id === id) r.status = 'revoked';
              return new Response(null, { status: 204 });
            }
            if (tail === '/verify') {
              verified.push(id!);
              // The probe writes health, as the real one does — what the re-read must show.
              for (const r of rows) if (r.id === id) Object.assign(r, { status: 'active', lastError: null });
              return Response.json({ ok: true, accountRef: null, accountLabel: null, facts: [], error: null });
            }
            if (tail === '/activity') return Response.json({ source: 'ledger', live: false, entries: [] });
            if (tail === '/credential') return Response.json({ fields: [] });
          }
          if (path === `/tenants/${tenant}/connection-grants`) return Response.json([]);
          if (path === `/tenants/${tenant}/scopes/${appScope}/intents`) return Response.json(intents);
          if (path === '/sweep-runs') return Response.json({ entries: [], nextCursor: null });
          return Response.json({ error: `unexpected ${method} ${path}` }, { status: 500 });
        },
      },
    };
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const req = (path: string, method = 'GET') =>
    app.request(`/api/teams/${tenant}/apps/${appScope}/integrations${path}`, { method, headers: { cookie: 'sb_session=sub-owner' } }, env);

  const byLabel = (label: string) => rows.find((r) => r.label === label)!;

  it('uses the app path team when another tab has switched the shared cookie', async () => {
    const otherTeam = tenantId.parse(ulid());
    const otherScope = scopeId.parse(ulid());
    const otherOwner = principalId.parse(ulid());
    await provisionDashboard(host, { tenantId: otherTeam, scopeId: otherScope, owner: otherOwner, slug: 'other-team', name: 'Other Team' });
    await host.admin.linkIdentity(staff, {
      provider: 'authhero', externalId: 'sub-owner', principal: otherOwner, tenantId: otherTeam, scopeId: otherScope,
    });
    const otherApp = scopeId.parse(ulid());
    const otherDash = await host.getScope(otherOwner, otherTeam, otherScope);
    await otherDash.invoke('dashboard/provision-app', { appScopeId: otherApp, verticalSlug: VERTICAL, name: 'Other App' });

    const response = await app.request(`/api/teams/${tenant}/apps/${appScope}/integrations`, {
      headers: { cookie: `sb_session=sub-owner; sb_team=${otherTeam}` },
    }, env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { providers: { provider: string }[] };
    expect(body.providers.map((p) => p.provider)).toEqual(['fortnox', 'acme.docbox', 'scrive']);
    expect((await app.request(`/api/teams/${tenant}/apps/${otherApp}/integrations`, {
      headers: { cookie: `sb_session=sub-owner; sb_team=${otherTeam}` },
    }, env)).status).toBe(404);

    const outside = tenantId.parse(ulid());
    const base = `/api/teams/${outside}/apps/${appScope}/integrations`;
    const before = planeCalls.length;
    for (const [path, method] of [
      ['', 'GET'], ['/acme.docbox', 'POST'], ['/fortnox', 'DELETE'],
      [`/fortnox/connections/${byLabel('Alfa AB').id}`, 'DELETE'],
      ['/fortnox/verify', 'POST'], ['/fortnox/activity', 'GET'],
    ] as const) {
      expect((await app.request(`${base}${path}`, { method, headers: { cookie: 'sb_session=sub-owner' } }, env)).status).toBe(404);
    }
    expect(planeCalls).toHaveLength(before);
    for (const [path, method] of [
      ['', 'GET'], ['/acme.docbox', 'POST'], ['/fortnox', 'DELETE'],
      [`/fortnox/connections/${byLabel('Alfa AB').id}`, 'DELETE'],
      ['/fortnox/verify', 'POST'], [`/fortnox/connections/${byLabel('Alfa AB').id}/verify`, 'POST'],
      ['/fortnox/activity', 'GET'], [`/fortnox/connections/${byLabel('Alfa AB').id}/activity`, 'GET'],
    ] as const) {
      expect((await app.request(`/api/apps/${appScope}/integrations${path}`, {
        method, headers: { cookie: 'sb_session=sub-owner' },
      }, env)).status).toBe(404);
    }
  });

  it('keeps connect, disconnect and verify gated by the path team scope', async () => {
    const viewer = principalId.parse(ulid());
    await host.admin.assignRole(staff, { principalId: viewer, roleKey: 'viewer', node: { tenantId: tenant, scopeId: null } });
    await host.admin.linkIdentity(staff, {
      provider: 'authhero', externalId: 'sub-viewer', principal: viewer, tenantId: tenant, scopeId: dashScope,
    });
    const base = `/api/teams/${tenant}/apps/${appScope}/integrations`;
    const send = (path: string, method: string, body?: unknown) => app.request(`${base}${path}`, {
      method,
      headers: { cookie: 'sb_session=sub-viewer', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, env);
    expect((await send('/acme.docbox', 'POST', { secret: { apiKey: 'key', archive: 'archive' } })).status).toBe(403);
    expect((await send('/scrive', 'DELETE')).status).toBe(403);
    expect((await send(`/fortnox/connections/${byLabel('Alfa AB').id}`, 'DELETE')).status).toBe(403);
    expect((await send('/fortnox/verify', 'POST')).status).toBe(403);
    expect((await send(`/fortnox/connections/${byLabel('Alfa AB').id}/verify`, 'POST')).status).toBe(403);
    expect(upserts).toEqual([]);
    expect(revoked).toEqual([]);
    expect(verified).toEqual([]);
  });

  it('lists every live company of the fleet, newest first, and says the provider is multi-account', async () => {
    const res = await req('');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      providers: { provider: string; multiAccount: boolean; connection: { id: string } | null; connections: { id: string; label: string }[] }[];
    };
    const fortnox = body.providers.find((p) => p.provider === 'fortnox')!;
    expect(fortnox.multiAccount).toBe(true);
    expect(fortnox.connections.map((c) => c.label)).toEqual(['Gamma AB', 'Beta AB', 'Alfa AB']);
    // The single-connection field is unchanged: the newest row of an all-account-keyed fleet.
    expect(fortnox.connection?.id).toBe(byLabel('Gamma AB').id);
    const scrive = body.providers.find((p) => p.provider === 'scrive')!;
    expect(scrive.multiAccount).toBe(false);
    expect(scrive.connections.map((c) => c.label)).toEqual(['Scrive']);
  });

  it('disconnects exactly the addressed company and leaves the rest of the fleet', async () => {
    const beta = byLabel('Beta AB');
    expect((await req(`/fortnox/connections/${beta.id}`, 'DELETE')).status).toBe(200);
    expect(revoked).toEqual([beta.id]);
    const body = (await (await req('')).json()) as { providers: { provider: string; connections: { label: string }[] }[] };
    expect(body.providers.find((p) => p.provider === 'fortnox')!.connections.map((c) => c.label)).toEqual([
      'Gamma AB',
      'Alfa AB',
    ]);
  });

  it('the un-addressed disconnect still refuses to pick one of many', async () => {
    expect((await req('/fortnox', 'DELETE')).status).toBe(409);
    expect(revoked).toEqual([]);
  });

  it('refuses an id that is not one of this app’s live rows for this provider — 404, nothing touched', async () => {
    const foreign = [
      byLabel('Other AB').id, // same provider, another vertical
      byLabel('Scrive').id, // this vertical, another provider
      byLabel('Gone AB').id, // this fleet, already revoked
      ulid(), // nobody's
    ];
    for (const id of foreign) {
      expect((await req(`/fortnox/connections/${id}`, 'DELETE')).status).toBe(404);
      expect((await req(`/fortnox/connections/${id}/verify`, 'POST')).status).toBe(404);
      expect((await req(`/fortnox/connections/${id}/activity`)).status).toBe(404);
    }
    expect(revoked).toEqual([]);
    expect(verified).toEqual([]);
  });

  it('verifies the addressed company and re-reads that same row afterwards', async () => {
    const beta = byLabel('Beta AB');
    const res = await req(`/fortnox/connections/${beta.id}/verify`, 'POST');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; connection?: { id: string; status: string; lastError: string | null } };
    expect(verified).toEqual([beta.id]);
    // Not the newest row: the one that was probed, with the health the probe just wrote.
    expect(body.connection).toMatchObject({ id: beta.id, status: 'active', lastError: null });
  });

  it('reads the activity of the addressed company', async () => {
    const alfa = byLabel('Alfa AB');
    const res = await req(`/fortnox/connections/${alfa.id}/activity`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { connection: { id: string } }).connection.id).toBe(alfa.id);
  });

  it('names an intent row whose identity did not decode, apart from the deliveries — never drops it (#1637)', async () => {
    const delivered = {
      id: ulid(),
      kind: 'connector:fortnox',
      payload: { event: { type: 'invoice.sent' } },
      requestedBy: { system: 'connector-dispatch' },
      impersonation: null,
      status: 'done',
      attempts: 1,
      lastError: null,
      failure: null,
      result: null,
      requestedAt: '2026-09-01T00:00:00.000Z',
      settledAt: '2026-09-01T00:00:01.000Z',
    };
    const unreadable = {
      undecodable: true,
      id: 'not-a-ulid',
      kind: 'connector:fortnox',
      status: 'queued',
      attempts: '0',
      requestedAt: '1756684800',
      decodeError: 'id: Invalid string; status: Invalid option',
    };
    intents = [unreadable, delivered];
    const res = await req(`/fortnox/connections/${byLabel('Alfa AB').id}/activity`);
    const body = (await res.json()) as { intents: { id: string }[]; unreadableIntents: unknown[] };
    // The delivery list is exactly the rows that ARE deliveries…
    expect(body.intents.map((i) => i.id)).toEqual([delivered.id]);
    // …and the row that is not one is named as stored, not folded into an empty drawer.
    expect(body.unreadableIntents).toEqual([
      { id: 'not-a-ulid', status: 'queued', requestedAt: '1756684800', decodeError: 'id: Invalid string; status: Invalid option' },
    ]);
  });

  it('a clean journal names nothing unreadable (the positive twin)', async () => {
    const res = await req(`/fortnox/connections/${byLabel('Alfa AB').id}/activity`);
    expect(((await res.json()) as { unreadableIntents: unknown[] }).unreadableIntents).toEqual([]);
  });

  it('every addressed route needs a signed-in member of the team', async () => {
    const id = byLabel('Alfa AB').id;
    const anon = await app.request(`/api/teams/${tenant}/apps/${appScope}/integrations/fortnox/connections/${id}`, { method: 'DELETE' }, env);
    expect(anon.status).toBe(401);
    expect(revoked).toEqual([]);
  });

  // Vertical-defined connectors (vertical-connectors.md §7.2): declared on the vertical's
  // registry record, offered on its apps' panel only, stored with the declaration's grants.
  it('offers the connector the vertical declares, with its form, beside the first-party ones', async () => {
    const body = (await (await req('')).json()) as {
      providers: { provider: string; name: string; monogram: string; required: boolean; fields: unknown[]; connectFlow: unknown }[];
    };
    expect(body.providers.map((p) => p.provider)).toEqual(['fortnox', 'acme.docbox', 'scrive']);
    expect(body.providers.find((p) => p.provider === 'acme.docbox')).toMatchObject({
      name: 'docbox archive',
      monogram: 'DO',
      required: true,
      connectFlow: null,
      fields: DOC_CONNECTOR.fields,
    });
  });

  it('connecting the declared connector stores the parsed secret with the declared grants', async () => {
    const res = await app.request(
      `/api/teams/${tenant}/apps/${appScope}/integrations/acme.docbox`,
      {
        method: 'POST',
        headers: { cookie: 'sb_session=sub-owner', 'content-type': 'application/json' },
        body: JSON.stringify({ secret: { apiKey: ' k-1 ', archive: 'arc-9', stray: 'dropped' } }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(upserts).toEqual([
      expect.objectContaining({
        scopeId: appScope,
        provider: 'acme.docbox',
        secret: { apiKey: 'k-1', archive: 'arc-9' },
        grants: ['books:file-document'],
      }),
    ]);
  });

  it('keeps a provider refusal on connect as a 422 with its probe', async () => {
    refuseUpsert = true;
    const res = await app.request(`/api/teams/${tenant}/apps/${appScope}/integrations/acme.docbox`, {
      method: 'POST',
      headers: { cookie: 'sb_session=sub-owner', 'content-type': 'application/json' },
      body: JSON.stringify({ secret: { apiKey: 'bad', archive: 'archive' } }),
    }, env);
    expect(res.status).toBe(422);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(await res.json()).toMatchObject({ error: 'Provider refused the credential', probe: { ok: false, refused: true, error: 'Invalid credential' } });
  });

  it('a provider another vertical declares is no door on this app — 404, nothing stored', async () => {
    const post = await app.request(
      `/api/teams/${tenant}/apps/${appScope}/integrations/acme.other`,
      {
        method: 'POST',
        headers: { cookie: 'sb_session=sub-owner', 'content-type': 'application/json' },
        body: JSON.stringify({ secret: { apiKey: 'k', archive: 'a' } }),
      },
      env,
    );
    expect(post.status).toBe(404);
    expect((await req('/acme.other', 'DELETE')).status).toBe(404);
    expect((await req('/acme.other/verify', 'POST')).status).toBe(404);
    expect(upserts).toEqual([]);
  });

  it('a live connection outlives the declaration: still listed, formless, and revocable', async () => {
    const live = row({ provider: 'acme.docbox', label: 'Docbox' });
    // Another vertical's connection to a provider of the same shape — still not this app's.
    const foreign = row({ vertical: 'acme/other', provider: 'acme.other', label: 'Other archive' });
    rows.push(live, foreign);
    declared = [];
    const body = (await (await req('')).json()) as {
      providers: { provider: string; required: boolean; fields: unknown[]; connection: { id: string } | null }[];
    };
    expect(body.providers.find((p) => p.provider === 'acme.docbox')).toMatchObject({
      required: false,
      fields: [],
      connection: { id: live.id },
    });
    expect(body.providers.some((p) => p.provider === 'acme.other')).toBe(false);
    // Connecting and verifying still need a declaration; withdrawing never does.
    expect((await req('/acme.docbox/verify', 'POST')).status).toBe(404);
    expect((await req(`/acme.other/connections/${foreign.id}`, 'DELETE')).status).toBe(404);
    expect((await req('/acme.other', 'DELETE')).status).toBe(404);
    expect((await req('/acme.docbox', 'DELETE')).status).toBe(200);
    expect(revoked).toEqual([live.id]);
  });

  it('the addressed revoke reaches an undeclared connection of this vertical too', async () => {
    const live = row({ provider: 'acme.docbox', label: 'Docbox' });
    rows.push(live);
    declared = [];
    expect((await req(`/acme.docbox/connections/${live.id}`, 'DELETE')).status).toBe(200);
    expect(revoked).toEqual([live.id]);
  });
});
