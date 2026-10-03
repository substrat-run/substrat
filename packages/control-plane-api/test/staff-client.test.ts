import { describe, expect, it } from 'vitest';
import { ControlPlaneClient, ControlPlaneError, ControlPlaneStaffClient } from '../src/index.js';
import { DEV_ACTOR_HEADER, SERVICE_TOKEN_HEADER } from '../src/auth.js';

/**
 * The staff client (#971) is the console's hand-rolled client moved behind the shared
 * transport. What these tests pin is the wire: for every method, the URL, the verb and the
 * body that go out — because the console's views are written against exactly those, and a
 * rename of a path segment or a dropped `encodeURIComponent` would pass every type check.
 */

const T = '01HT00000000000000000000T0';
const S = '01HS00000000000000000000S0';
const BASE = 'http://cp.local';

interface Seen {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
  init: RequestInit;
}

function spy(respond: () => Response = () => Response.json({ ok: true })) {
  const seen: Seen[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      headers: init?.headers as Record<string, string>,
      init: init ?? {},
    });
    return respond();
  }) as typeof globalThis.fetch;
  return { seen, fetch };
}

const make = (fetch: typeof globalThis.fetch, extra: Partial<ConstructorParameters<typeof ControlPlaneStaffClient>[0]> = {}) =>
  new ControlPlaneStaffClient({ baseUrl: BASE, actor: 'actor-1', fetch, ...extra });

type C = ControlPlaneStaffClient;
// method → [call, expected verb, expected path+query, expected JSON body]
const WIRE: Record<string, [(c: C) => Promise<unknown>, string, string, unknown?]> = {
  listTenants: [(c) => c.listTenants({ limit: 5, cursor: 'c1', order: 'desc' }), 'GET', '/tenants?limit=5&cursor=c1&order=desc'],
  getTenant: [(c) => c.getTenant(T as never), 'GET', `/tenants/${T}`],
  createTenant: [(c) => c.createTenant({ id: T as never, slug: 'acme', name: 'Acme' }), 'POST', '/tenants', { id: T, slug: 'acme', name: 'Acme' }],
  setTenantStatus: [(c) => c.setTenantStatus(T as never, 'suspended' as never), 'PATCH', `/tenants/${T}/status`, { status: 'suspended' }],
  reapTenant: [(c) => c.reapTenant(T as never), 'POST', `/tenants/${T}/reap`],
  platformRuntime: [(c) => c.platformRuntime(), 'GET', '/platform/runtime'],
  doNamespaces: [(c) => c.doNamespaces('my script'), 'GET', '/platform/do-namespaces?script=my+script'],
  tenantStores: [(c) => c.tenantStores(T as never), 'GET', `/tenants/${T}/stores`],
  listEntitlements: [(c) => c.listEntitlements(T as never), 'GET', `/tenants/${T}/entitlements`],
  grantEntitlement: [(c) => c.grantEntitlement(T as never, 't-1/crm eff', { plan: 'pro' } as never), 'PUT', `/tenants/${T}/entitlements/t-1%2Fcrm%20eff`, { plan: 'pro' }],
  revokeEntitlement: [(c) => c.revokeEntitlement(T as never, 't-1/crm'), 'DELETE', `/tenants/${T}/entitlements/t-1%2Fcrm`],
  readMeters: [(c) => c.readMeters(T as never), 'GET', `/meters?tenantId=${T}`],
  readStorage: [(c) => c.readStorage(T as never, S as never), 'GET', `/meters/storage?tenantId=${T}&cursor=${S}`],
  readModelUsage: [(c) => c.readModelUsage({ tenantId: T as never, since: '2026-09-01' }), 'GET', `/model-usage/summary?tenantId=${T}&since=2026-09-01`],
  listScopes: [(c) => c.listScopes({ tenantId: T as never, status: ['active', 'suspended'] as never, limit: 50 }), 'GET', `/scopes?tenantId=${T}&status=active&status=suspended&limit=50`],
  migrationProgress: [(c) => c.migrationProgress('todo'), 'GET', '/fleet/migrations?vertical=todo'],
  getScope: [(c) => c.getScope(T as never, S as never), 'GET', `/tenants/${T}/scopes/${S}`],
  scopeHealth: [(c) => c.scopeHealth(T as never, S as never), 'GET', `/tenants/${T}/scopes/${S}/health`],
  denialSummary: [(c) => c.denialSummary(T as never, S as never, { actor: 'a' } as never), 'GET', `/tenants/${T}/scopes/${S}/denials/summary?actor=a`],
  listDenials: [(c) => c.listDenials(T as never, S as never), 'GET', `/tenants/${T}/scopes/${S}/denials`],
  listCapabilities: [(c) => c.listCapabilities(T as never, S as never, { includeRevoked: true, limit: 5 }), 'GET', `/tenants/${T}/scopes/${S}/capabilities?includeRevoked=true&limit=5`],
  systemGrantsStatus: [(c) => c.systemGrantsStatus(T as never, S as never), 'GET', `/tenants/${T}/scopes/${S}/system-grants`],
  switchScheduleOff: [(c) => c.switchScheduleOff(T as never, S as never, 'm' as never, 'why'), 'DELETE', `/tenants/${T}/scopes/${S}/system-grants`, { moduleId: 'm', reason: 'why' }],
  switchScheduleOn: [(c) => c.switchScheduleOn(T as never, S as never, 'm' as never, 'why'), 'POST', `/tenants/${T}/scopes/${S}/system-grants`, { moduleId: 'm', reason: 'why' }],
  peerGrantsStatus: [(c) => c.peerGrantsStatus(T as never, S as never), 'GET', `/tenants/${T}/scopes/${S}/peer-grants`],
  switchPeerOff: [(c) => c.switchPeerOff(T as never, S as never, 'v', 'why'), 'DELETE', `/tenants/${T}/scopes/${S}/peer-grants`, { vertical: 'v', reason: 'why' }],
  switchPeerOn: [(c) => c.switchPeerOn(T as never, S as never, 'v', 'why'), 'POST', `/tenants/${T}/scopes/${S}/peer-grants`, { vertical: 'v', reason: 'why' }],
  crossVerticalEdges: [(c) => c.crossVerticalEdges(T as never), 'GET', `/tenants/${T}/cross-vertical/edges`],
  moveImportCursor: [(c) => c.moveImportCursor(T as never, S as never, { to: 'x' } as never), 'POST', `/tenants/${T}/scopes/${S}/import-cursor`, { to: 'x' }],
  provisionScope: [(c) => c.provisionScope({ tenantId: T as never, scopeId: S as never, storageShape: 'A' }), 'POST', '/scopes', { tenantId: T, scopeId: S, storageShape: 'A' }],
  activateScope: [(c) => c.activateScope(T as never, S as never), 'POST', `/tenants/${T}/scopes/${S}/activate`],
  suspendScope: [(c) => c.suspendScope(T as never, S as never), 'POST', `/tenants/${T}/scopes/${S}/suspend`],
  unsuspendScope: [(c) => c.unsuspendScope(T as never, S as never), 'POST', `/tenants/${T}/scopes/${S}/unsuspend`],
  reprovisionScope: [(c) => c.reprovisionScope(T as never, S as never), 'POST', `/tenants/${T}/scopes/${S}/provision`],
  archiveScope: [(c) => c.archiveScope(T as never, S as never), 'POST', `/tenants/${T}/scopes/${S}/archive`],
  unarchiveScope: [(c) => c.unarchiveScope(T as never, S as never), 'POST', `/tenants/${T}/scopes/${S}/unarchive`],
  // `backup: true` rides ALWAYS on a default reap (#493) — the safety the console relies on.
  reapScope: [(c) => c.reapScope(T as never, S as never), 'POST', `/tenants/${T}/scopes/${S}/reap`, { backup: true }],
  rebindScopeVertical: [(c) => c.rebindScopeVertical(T as never, S as never, 'v', { ackMigrations: true }), 'POST', `/tenants/${T}/scopes/${S}/rebind-vertical`, { vertical: 'v', ackMigrations: true }],
  listScopeBackups: [(c) => c.listScopeBackups(T as never, S as never), 'GET', `/tenants/${T}/scopes/${S}/backups`],
  backupScope: [(c) => c.backupScope(T as never, S as never), 'POST', `/tenants/${T}/scopes/${S}/backups`],
  listDirectoryBackups: [(c) => c.listDirectoryBackups(), 'GET', '/directory/backups'],
  backupDirectory: [(c) => c.backupDirectory(), 'POST', '/directory/backups'],
  deleteScope: [(c) => c.deleteScope(T as never, S as never), 'DELETE', `/tenants/${T}/scopes/${S}`],
  listRoles: [(c) => c.listRoles({ tenantId: T as never, source: 'vertical' }), 'GET', `/roles?tenantId=${T}&source=vertical`],
  listHostnames: [(c) => c.listHostnames({ scopeId: S as never }), 'GET', `/hostnames?scopeId=${S}`],
  bindHostname: [(c) => c.bindHostname({ hostname: 'a.example', tenantId: T as never, scopeId: S as never, surface: 'app' }), 'POST', '/hostnames', { hostname: 'a.example', tenantId: T, scopeId: S, surface: 'app' }],
  setHostnameStatus: [(c) => c.setHostnameStatus('a/b.example', 'active' as never, 'n'), 'PATCH', '/hostnames/a%2Fb.example/status', { status: 'active', note: 'n' }],
  unbindHostname: [(c) => c.unbindHostname('a/b.example'), 'DELETE', '/hostnames/a%2Fb.example'],
  provisionInstance: [(c) => c.provisionInstance('my vertical', { tenantId: T as never, scopeId: S as never, owner: 'o', slug: 's', name: 'n' }), 'POST', '/verticals/my%20vertical/instances', { tenantId: T, scopeId: S, owner: 'o', slug: 's', name: 'n' }],
  adminLog: [(c) => c.adminLog({ action: ['tenant.create', 'scope.reap'] as never, actor: 'x' }), 'GET', '/admin-log?action=tenant.create&action=scope.reap&actor=x'],
  listOpsFailures: [(c) => c.listOpsFailures({ reference: 'r1' }), 'GET', '/ops-failures?reference=r1'],
  listSweepRuns: [(c) => c.listSweepRuns({ kind: 'connection' as never, outcome: 'failed' }), 'GET', '/sweep-runs?kind=connection&outcome=failed'],
  listSystemSwitches: [(c) => c.listSystemSwitches({ position: 'all' }), 'GET', '/system-switches?position=all'],
  listConnectionHealth: [(c) => c.listConnectionHealth({ q: 'a b' }), 'GET', '/connections/health?q=a+b'],
  connectorCalls: [(c) => c.connectorCalls({ hours: 24, provider: 'scrive' }), 'GET', '/connections/calls?hours=24&provider=scrive'],
  listIssues: [(c) => c.listIssues({ status: 'open' as never }), 'GET', '/issues?status=open'],
  setIssueStatus: [(c) => c.setIssueStatus('fp\u001fx', 'resolved' as never), 'PUT', '/issues/status', { fingerprint: 'fp\u001fx', status: 'resolved' }],
  listVerticals: [(c) => c.listVerticals(), 'GET', '/verticals'],
  registerVertical: [(c) => c.registerVertical({ slug: 'v', name: 'V', source: { kind: 'x' } as never }), 'POST', '/verticals', { slug: 'v', name: 'V', source: { kind: 'x' } }],
  listVersions: [(c) => c.listVersions('v/1', { limit: 3 }), 'GET', '/verticals/v%2F1/versions?limit=3'],
  admitVersion: [(c) => c.admitVersion('v', 'ver1'), 'POST', '/verticals/v/versions/ver1/admit'],
  rejectVersion: [(c) => c.rejectVersion('v', 'ver1', 'no'), 'POST', '/verticals/v/versions/ver1/reject', { note: 'no' }],
  listChannels: [(c) => c.listChannels('v'), 'GET', '/verticals/v/channels'],
  setVerticalListed: [(c) => c.setVerticalListed('v', true), 'POST', '/verticals/v/listing', { listed: true }],
  setInstallsBlocked: [(c) => c.setInstallsBlocked('v', false), 'POST', '/verticals/v/install-block', { blocked: false }],
  setTenantProvisioner: [(c) => c.setTenantProvisioner('v', true), 'POST', '/verticals/v/tenant-provisioner', { granted: true }],
  setEmailSender: [(c) => c.setEmailSender('v', true), 'POST', '/verticals/v/email-sender', { granted: true }],
  deleteVertical: [(c) => c.deleteVertical('v'), 'DELETE', '/verticals/v'],
  promoteVersion: [(c) => c.promoteVersion('v', 'prod' as never, 'ver1'), 'POST', '/verticals/v/channels/prod/promote', { versionId: 'ver1' }],
  promotionImpact: [(c) => c.promotionImpact('v', 'prod' as never, 'ver 1'), 'GET', '/verticals/v/channels/prod/promote-impact?versionId=ver%201'],
  versionRegistry: [(c) => c.versionRegistry('v', 'ver 1'), 'GET', '/verticals/v/versions/ver%201/registry'],
  versionMigrations: [(c) => c.versionMigrations('v', 'ver1', 'base 0'), 'GET', '/verticals/v/versions/ver1/migrations?base=base%200'],
  bindScopeVersion: [(c) => c.bindScopeVersion(T as never, S as never, 'ver1'), 'POST', `/tenants/${T}/scopes/${S}/version`, { versionId: 'ver1' }],
  listMembers: [(c) => c.listMembers(), 'GET', '/members'],
  grantStaffAccess: [(c) => c.grantStaffAccess('a@b.c', 'A'), 'POST', '/members/staff', { email: 'a@b.c', name: 'A' }],
  revokeStaffAccess: [(c) => c.revokeStaffAccess('a@b.c'), 'POST', '/members/staff/revoke', { email: 'a@b.c' }],
  serviceMetrics: [(c) => c.serviceMetrics(6), 'GET', '/observability/metrics?hours=6'],
  recentLogs: [(c) => c.recentLogs({ service: 's', limit: 10 }), 'GET', '/observability/logs?service=s&limit=10'],
  verticalEgress: [(c) => c.verticalEgress('v', { hours: 24 }), 'GET', '/verticals/v/egress?hours=24'],
  platformRequestBacklog: [(c) => c.platformRequestBacklog(), 'GET', '/platform-requests/backlog'],
};

describe('ControlPlaneStaffClient — the wire', () => {
  it('has a wire row for every method it carries', () => {
    const { fetch } = spy();
    const methods = Object.entries(make(fetch))
      .filter(([k, v]) => typeof v === 'function' && k !== 'post' && k !== 'fetchImpl')
      .map(([k]) => k)
      .sort();
    expect(Object.keys(WIRE).sort()).toEqual(methods);
  });

  it.each(Object.entries(WIRE))('%s', async (_name, [run, method, path, body]) => {
    const { seen, fetch } = spy();
    await run(make(fetch));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe(method);
    expect(seen[0]!.url).toBe(`${BASE}${path}`);
    expect(seen[0]!.body).toEqual(body);
  });

  it('sends the one-argument no-body calls with no body at all, not "null"', async () => {
    const { seen, fetch } = spy();
    await make(fetch).reapTenant(T as never);
    expect(seen[0]!.init.body).toBeUndefined();
  });

  it('hands methods around unbound — the console passes `api.suspendScope` as a callback', async () => {
    const { seen, fetch } = spy();
    const { suspendScope } = make(fetch);
    await suspendScope(T as never, S as never);
    expect(seen[0]!.url).toBe(`${BASE}/tenants/${T}/scopes/${S}/suspend`);
  });
});

describe('ControlPlaneStaffClient — credentials', () => {
  it('sends the dev actor and the JSON content type, and no cookie opt-in by default', async () => {
    const { seen, fetch } = spy();
    await make(fetch).listMembers();
    expect(seen[0]!.headers).toEqual({ [DEV_ACTOR_HEADER]: 'actor-1', 'content-type': 'application/json' });
    expect('credentials' in seen[0]!.init).toBe(false);
  });

  it('sends NO actor header for a null actor — the session cookie authenticates instead', async () => {
    const { seen, fetch } = spy();
    await make(fetch, { actor: null, credentials: 'include' }).listMembers();
    expect(seen[0]!.headers).toEqual({ 'content-type': 'application/json' });
    expect(seen[0]!.init.credentials).toBe('include');
  });

  it('sends only the service token when one is set (#980) — and never the actor beside it', async () => {
    const { seen, fetch } = spy();
    await make(fetch, { serviceToken: 'tok' }).listMembers();
    expect(seen[0]!.headers).toEqual({ [SERVICE_TOKEN_HEADER]: 'tok', 'content-type': 'application/json' });
  });

  it('keeps a relative base ("/api") and drops a trailing slash', async () => {
    const { seen, fetch } = spy();
    await make(fetch, { baseUrl: '/api/' }).listMembers();
    expect(seen[0]!.url).toBe('/api/members');
  });
});

describe('ControlPlaneStaffClient — answers and refusals', () => {
  it('reads a 204 as undefined, never a JSON parse of nothing', async () => {
    const { fetch } = spy(() => new Response(null, { status: 204 }));
    await expect(make(fetch).unbindHostname('a.example')).resolves.toBeUndefined();
  });

  it('hands the parsed JSON body back', async () => {
    const { fetch } = spy(() => Response.json({ staff: [] }));
    await expect(make(fetch).listMembers()).resolves.toEqual({ staff: [] });
  });

  it('a success body that is not JSON rejects rather than answering garbage', async () => {
    const { fetch } = spy(() => new Response('<html>', { status: 200 }));
    await expect(make(fetch).listMembers()).rejects.toThrow();
  });

  it("raises the plane's problem document as a ControlPlaneError, detail first", async () => {
    const { fetch } = spy(() =>
      Response.json({ type: 'about:blank', title: 'Conflict', status: 409, detail: 'a scope is still bound', error: 'dup' }, { status: 409 }),
    );
    const err = await make(fetch).deleteVertical('v').catch((e) => e);
    expect(err).toBeInstanceOf(ControlPlaneError);
    expect(err).toMatchObject({ status: 409, message: 'a scope is still bound' });
  });

  it('still reads the legacy { error } refusal', async () => {
    const { fetch } = spy(() => Response.json({ error: 'nope' }, { status: 403 }));
    await expect(make(fetch).listMembers()).rejects.toMatchObject({ status: 403, message: 'nope' });
  });

  it('falls back to the status line for a proxy or crash page', async () => {
    const { fetch } = spy(() => new Response('<html>bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }));
    await expect(make(fetch).listMembers()).rejects.toMatchObject({ status: 502, message: '502 Bad Gateway' });
  });

  it('relays a 501 as status 501 — the views read it as "this plane predates the route"', async () => {
    const { fetch } = spy(() => Response.json({ detail: 'not configured' }, { status: 501 }));
    await expect(make(fetch).connectorCalls({ hours: 1 })).rejects.toMatchObject({ status: 501 });
  });

  it('a 404 is an error here — unlike the connect seam, which gates on absence', async () => {
    const { fetch } = spy(() => Response.json({ detail: 'unknown tenant' }, { status: 404 }));
    await expect(make(fetch).getTenant(T as never)).rejects.toMatchObject({ status: 404, message: 'unknown tenant' });
  });

  it('an unreachable plane is a ControlPlaneError at status 0, with the cause in the message', async () => {
    const fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof globalThis.fetch;
    const err = await make(fetch).listMembers().catch((e) => e);
    expect(err).toBeInstanceOf(ControlPlaneError);
    expect(err).toMatchObject({ status: 0, message: 'control plane unreachable: Failed to fetch' });
    // A view renders `e instanceof Error ? e.message : String(e)` — that must read as a sentence.
    expect(err).toBeInstanceOf(Error);
  });
});

describe('ControlPlaneClient — defaults are exactly today’s request (#971)', () => {
  // The transport moved under the connect seam; nothing a caller of THAT client sees may
  // move with it. Pinned against the literal request, headers and all.
  it('without a token: the actor header + content type, and no `credentials` key', async () => {
    const { seen, fetch } = spy();
    await new ControlPlaneClient({ baseUrl: `${BASE}/`, actor: 'actor-1', fetch }).createTenant({
      id: T as never,
      slug: 'acme',
      name: 'Acme',
    });
    expect(seen[0]!.init).toEqual({
      method: 'POST',
      body: JSON.stringify({ id: T, slug: 'acme', name: 'Acme' }),
      headers: { [DEV_ACTOR_HEADER]: 'actor-1', 'content-type': 'application/json' },
    });
    // `toEqual` reads an `undefined` value as absent; the key itself must not be there.
    expect('credentials' in seen[0]!.init).toBe(false);
    expect(seen[0]!.url).toBe(`${BASE}/tenants`);
  });

  it('with a token: only the token + content type', async () => {
    const { seen, fetch } = spy();
    await new ControlPlaneClient({ baseUrl: BASE, actor: 'actor-1', serviceToken: 'tok', fetch }).listEntitlements(T as never);
    expect(seen[0]!.init).toEqual({
      headers: { [SERVICE_TOKEN_HEADER]: 'tok', 'content-type': 'application/json' },
    });
  });

  it('an empty actor string still goes out as an (empty) header — it was never folded to "none"', async () => {
    const { seen, fetch } = spy();
    await new ControlPlaneClient({ baseUrl: BASE, actor: '', fetch }).listEntitlements(T as never);
    expect(seen[0]!.headers).toEqual({ [DEV_ACTOR_HEADER]: '', 'content-type': 'application/json' });
  });

  it('keeps one error class: the entry’s ControlPlaneError is the client package’s', async () => {
    const { ControlPlaneError: fromEntry } = await import('../src/index.js');
    const { ControlPlaneError: fromPackage } = await import('@substrat-run/control-plane-client');
    expect(fromEntry).toBe(fromPackage);
  });
});
