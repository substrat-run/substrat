import { describe, it, expect } from 'vitest';
import { principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { TenantNarrowedControlPlane, ControlPlaneError } from '../src/authority.js';

/**
 * The §4 seam (docs/design/dashboard.md): the Dashboard effects provisioning on the
 * shared control plane, but ONLY inside the caller's own tenant. The tenant is pinned
 * at construction, so operation code cannot name another — cross-tenant is impossible
 * by construction. These tests exercise that the pinned tenant is injected on every
 * write, the routes/headers are right, and idempotent creates tolerate a conflict.
 */
describe('TenantNarrowedControlPlane — the tenant-narrowed authority seam', () => {
  const T = tenantId.parse(ulid());
  const S = scopeId.parse(ulid());
  const owner = principalId.parse(ulid());

  interface Call { url: string; method: string; body: unknown; token: string | null }

  function harness(status = 200, payload: unknown = {}) {
    const calls: Call[] = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(init.body as string) : undefined,
        token: headers.get('x-service-token'),
      });
      return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof globalThis.fetch;
    const cp = new TenantNarrowedControlPlane({
      baseUrl: 'https://cp/api',
      actor: '01JZ000000000000000000TEST',
      serviceToken: 'secret-token',
      tenantId: T,
      fetch,
    });
    return { cp, calls };
  }

  it('injects the pinned tenant + service token on every write, at the right routes', async () => {
    const { cp, calls } = harness();
    await cp.ensureTenant('t-acme', 'Acme');
    await cp.grantEntitlement('callout');
    await cp.provisionScope({ scopeId: S, slug: 'acme-hr', name: 'Acme HR', vertical: 'callout', jurisdiction: 'global' });
    await cp.provisionInstance('callout', { scopeId: S, owner, slug: 'acme-hr', name: 'Acme HR' });
    await cp.activateScope(S);
    await cp.bindHostname({ hostname: 'acme-hr.global.substrat.run', scopeId: S, surface: 'app', canonical: true });
    await cp.setHostnameStatus('acme-hr.global.substrat.run', 'active');

    // Every request carried the service credential.
    expect(calls.every((c) => c.token === 'secret-token')).toBe(true);

    // The tenant is the pinned one, everywhere it appears — in the path or the body.
    const tenantCreate = calls[0]!;
    expect(tenantCreate.url).toBe('https://cp/api/tenants');
    expect((tenantCreate.body as { id: string }).id).toBe(T);

    expect(calls[1]!.url).toBe(`https://cp/api/tenants/${T}/entitlements/callout`);
    expect(calls[1]!.method).toBe('PUT');

    const provScope = calls[2]!;
    expect(provScope.url).toBe('https://cp/api/scopes');
    expect((provScope.body as { tenantId: string }).tenantId).toBe(T);

    const provInstance = calls[3]!;
    expect(provInstance.url).toBe('https://cp/api/verticals/callout/instances');
    expect((provInstance.body as { tenantId: string; owner: string }).tenantId).toBe(T);
    expect((provInstance.body as { owner: string }).owner).toBe(owner);

    expect(calls[4]!.url).toBe(`https://cp/api/tenants/${T}/scopes/${S}/activate`);

    const bind = calls[5]!;
    expect(bind.url).toBe('https://cp/api/hostnames');
    expect((bind.body as { tenantId: string; region: null; canonical: boolean }).tenantId).toBe(T);
    expect((bind.body as { region: null }).region).toBe(null);
    expect((bind.body as { canonical: boolean }).canonical).toBe(true);

    expect(calls[6]!.url).toBe('https://cp/api/hostnames/acme-hr.global.substrat.run/status');
    expect(calls[6]!.method).toBe('PATCH');
  });

  it('connection methods stay pinned to the tenant and never send a vertical', async () => {
    const { cp, calls } = harness(200, []);
    await cp.listConnections({ vertical: 'egeryds-crm', provider: 'scrive' });
    await cp.upsertConnection({
      scopeId: S,
      provider: 'scrive',
      label: 'Scrive (testbed)',
      secret: { clientId: 'a', clientSecret: 'b', tokenId: 'c', tokenSecret: 'd' },
      grants: ['protocol:record-signature'],
      createdBy: owner,
    });
    await cp.revokeConnection('01JZ00000000000000000000CN');

    expect(calls[0]!.url).toBe(`https://cp/api/tenants/${T}/connections?vertical=egeryds-crm&provider=scrive`);
    expect(calls[0]!.method).toBe('GET');

    const upsert = calls[1]!;
    expect(upsert.url).toBe(`https://cp/api/tenants/${T}/connections`);
    expect(upsert.method).toBe('POST');
    // The vertical is re-derived plane-side from the scope record — the body names the
    // scope, never a tenant or a vertical.
    expect(upsert.body).toEqual({
      scopeId: S,
      provider: 'scrive',
      label: 'Scrive (testbed)',
      secret: { clientId: 'a', clientSecret: 'b', tokenId: 'c', tokenSecret: 'd' },
      grants: ['protocol:record-signature'],
      createdBy: owner,
    });
    expect(calls[2]!.url).toBe(`https://cp/api/tenants/${T}/connections/01JZ00000000000000000000CN`);
    expect(calls[2]!.method).toBe('DELETE');
    expect(calls.every((c) => c.token === 'secret-token')).toBe(true);
  });

  it('the inspection reads (#605) are tenant-pinned, and only ask for live state when told to', async () => {
    const { cp, calls } = harness(200, []);
    const CN = '01JZ00000000000000000000CN';
    await cp.verifyConnection(CN);
    await cp.connectionActivity(CN);
    await cp.connectionActivity(CN, { live: true });
    await cp.listConnectionGrants();

    // Verify REACHES OUT (it spends a call at the provider and writes health), so it is
    // a POST — not the safe, cacheable read a GET promises.
    expect(calls[0]!).toMatchObject({ url: `https://cp/api/tenants/${T}/connections/${CN}/verify`, method: 'POST' });
    // The ledger's own view by default; the provider is only read when asked.
    expect(calls[1]!).toMatchObject({ url: `https://cp/api/tenants/${T}/connections/${CN}/activity`, method: 'GET' });
    expect(calls[2]!.url).toBe(`https://cp/api/tenants/${T}/connections/${CN}/activity?live=1`);
    expect(calls[3]!.url).toBe(`https://cp/api/tenants/${T}/connection-grants`);
    expect(calls.every((c) => c.token === 'secret-token')).toBe(true);
  });

  it('listScopes reads GET /scopes narrowed to the pinned tenant + vertical (Data-tab switcher)', async () => {
    const { cp, calls } = harness(200, {
      entries: [{ id: S, tenantId: T, name: 'Cafe', status: 'active', vertical: 'manyfold' }],
      nextCursor: null,
    });
    const scopes = await cp.listScopes('manyfold');

    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.token).toBe('secret-token');
    // Complete-list semantics: the wrapper walks max-size pages until the cursor runs out.
    expect(calls[0]!.url).toBe(`https://cp/api/scopes?tenantId=${T}&vertical=manyfold&limit=200`);
    expect(scopes).toEqual([{ id: S, tenantId: T, name: 'Cafe', status: 'active', vertical: 'manyfold' }]);
  });

  it('list reads WALK the CP’s `{entries, nextCursor}` pages to completion (the #458 envelope)', async () => {
    // Two pages: the first hands back a cursor, the second ends the walk. The wrapper
    // must follow it — internal callers rely on complete-list semantics.
    const pages = [
      { entries: [{ id: 'h1', tenantId: T, name: 'One', status: 'active', vertical: 'manyfold' }], nextCursor: 'h1' },
      { entries: [{ id: 'h2', tenantId: T, name: 'Two', status: 'active', vertical: 'manyfold' }], nextCursor: null },
    ];
    const calls: string[] = [];
    const fetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(JSON.stringify(pages[calls.length - 1] ?? { entries: [], nextCursor: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch;
    const cp = new TenantNarrowedControlPlane({
      baseUrl: 'https://cp/api',
      actor: '01JZ000000000000000000TEST',
      serviceToken: 'secret-token',
      tenantId: T,
      fetch,
    });
    const scopes = await cp.listScopes('manyfold');
    expect(scopes.map((s) => s.id)).toEqual(['h1', 'h2']);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('cursor=h1');
  });

  it('listVersionsPage returns the page envelope VERBATIM (the per-app Deployments walk)', async () => {
    const { cp, calls } = harness(200, {
      entries: [{ id: 'v2', version: '0.2.0', admission: 'admitted', admissionNote: null, deploymentRef: null, createdAt: 'now' }],
      nextCursor: 'v2',
    });
    const page = await cp.listVersionsPage('acme/helpdesk', { limit: 1, order: 'desc' });
    expect(calls[0]!.url).toBe('https://cp/api/verticals/acme%2Fhelpdesk/versions?limit=1&order=desc');
    expect(page.nextCursor).toBe('v2');
    expect(page.entries.map((v) => v.id)).toEqual(['v2']);

    // An unknown/unowned slug (404) reads as an exhausted empty page, mirroring listVersions' [].
    const missing = harness(404, { error: 'not found' });
    expect(await missing.cp.listVersionsPage('ghost', { limit: 1 })).toEqual({ entries: [], nextCursor: null });
  });

  it('the tenant is not a parameter of any method — op code cannot name another', () => {
    const { cp } = harness();
    // The pinned tenant is exposed read-only; nothing accepts a tenantId argument.
    expect(cp.tenantId).toBe(T);
    // provisionScope/provisionInstance/bindHostname take a scope + details, never a tenant.
    const provisionScopeArg: Parameters<typeof cp.provisionScope>[0] = { scopeId: S, slug: 'x', name: 'X', vertical: 'callout', jurisdiction: 'global' };
    expect('tenantId' in provisionScopeArg).toBe(false);
  });

  it('idempotent creates tolerate a 409 (tenant/entitlement already exists)', async () => {
    const { cp } = harness(409, { error: 'already exists' });
    await expect(cp.ensureTenant('t-acme', 'Acme')).resolves.toBeUndefined();
    await expect(cp.grantEntitlement('callout')).resolves.toBeUndefined();
  });

  it('a non-idempotent failure surfaces as ControlPlaneError', async () => {
    const { cp } = harness(500, { error: 'boom' });
    await expect(cp.provisionScope({ scopeId: S, slug: 'x', name: 'X', vertical: 'callout', jurisdiction: 'global' })).rejects.toBeInstanceOf(ControlPlaneError);
  });

  it('listChannels returns [] for a static-binding vertical (no versions) instead of throwing', async () => {
    const { cp } = harness(404, { error: 'not found' });
    await expect(cp.listChannels('callout')).resolves.toEqual([]);
  });

  it('reads and renames the pinned tenant at its own directory row', async () => {
    const { cp, calls } = harness();
    await cp.getTenant();
    await cp.setTenantName('Egeryds');
    expect(calls[0]!.url).toBe(`https://cp/api/tenants/${T}`);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[1]!.url).toBe(`https://cp/api/tenants/${T}`);
    expect(calls[1]!.method).toBe('PATCH');
    expect(calls[1]!.body).toEqual({ name: 'Egeryds' });

    // Not yet mirrored (404) reads as null, not a throw.
    const missing = harness(404, { error: 'unknown tenant' });
    await expect(missing.cp.getTenant()).resolves.toBeNull();
  });

  it('bindScopeVersion pins the scope under the pinned tenant', async () => {
    const { cp, calls } = harness();
    await cp.bindScopeVersion(S, '01JVERSION');
    expect(calls[0]!.url).toBe(`https://cp/api/tenants/${T}/scopes/${S}/version`);
    expect((calls[0]!.body as { versionId: string }).versionId).toBe('01JVERSION');
  });

  it('createPreview posts to the vertical previews route with the version + pin/empty flags (#509)', async () => {
    const { cp, calls } = harness(201, { scopeId: '01JPREVIEW', hostname: 'crm--test.example', url: 'https://crm--test.example', versionId: '01JVERSION', reused: false });
    const out = await cp.createPreview('crm', { tag: 'test', versionId: '01JVERSION', ttlHours: null, empty: true });
    // The bare slug — the seam's x-substrat-tenant header resolves it to the tenant's registry id.
    expect(calls[0]!.url).toBe('https://cp/api/verticals/crm/previews');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({ tag: 'test', versionId: '01JVERSION', ttlHours: null, empty: true });
    expect(out).toMatchObject({ scopeId: '01JPREVIEW', reused: false });
  });

  it('mirrors identity links under the pinned tenant, idempotently', async () => {
    const { cp, calls } = harness();
    await cp.linkIdentity({ provider: 'authhero', externalId: 'auth0|u1', principal: owner, scopeId: S });
    await cp.unlinkIdentity(owner);

    expect(calls[0]!.url).toBe(`https://cp/api/tenants/${T}/identities`);
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.body).toEqual({ provider: 'authhero', externalId: 'auth0|u1', principal: owner, scopeId: S });

    expect(calls[1]!.url).toBe(`https://cp/api/tenants/${T}/identities/${owner}`);
    expect(calls[1]!.method).toBe('DELETE');

    // Re-mirroring an existing link (the /api/me self-heal) tolerates a conflict.
    const conflicted = harness(409, { error: 'already linked' });
    await expect(
      conflicted.cp.linkIdentity({ provider: 'authhero', externalId: 'auth0|u1', principal: owner }),
    ).resolves.toBeUndefined();
  });

  // -- observability narrowing (design/observability.md §5, view 2) ----------
  // The plane's observability routes are staff-wide over the service token, so the
  // owner filter HERE is the entire tenant boundary for metrics and logs.

  const OTHER = tenantId.parse(ulid());

  /** A fetch harness with per-path payloads, for reads that fan out. */
  function routedHarness(routes: Record<string, unknown>) {
    const calls: string[] = [];
    const fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      const path = u.replace('https://cp/api', '');
      const hit = Object.entries(routes).find(([p]) => path === p || path.startsWith(`${p}?`));
      return new Response(JSON.stringify(hit ? hit[1] : []), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch;
    const cp = new TenantNarrowedControlPlane({
      baseUrl: 'https://cp/api',
      actor: '01JZ000000000000000000TEST',
      serviceToken: 'secret-token',
      tenantId: T,
      fetch,
    });
    return { cp, calls };
  }

  const registry = {
    // The CP's list routes answer the `{entries, nextCursor}` envelope now (#458).
    '/verticals': {
      entries: [
        { slug: 'acme/helpdesk', name: 'Helpdesk', source: 'cli', ownerTenant: T },
        { slug: 'rival/crm', name: 'CRM', source: 'cli', ownerTenant: OTHER },
      ],
      nextCursor: null,
    },
    '/verticals/acme%2Fhelpdesk/versions': {
      entries: [
        { id: 'v1', version: '0.1.0', admission: 'admitted', admissionNote: null, deploymentRef: 'acme-helpdesk-v1', createdAt: 'now' },
        { id: 'v0', version: '0.0.9', admission: 'admitted', admissionNote: null, deploymentRef: null, createdAt: 'now' },
      ],
      nextCursor: null,
    },
  };

  it('observabilityMetrics keeps only rows for OWNED services, mapped back to (vertical, version)', async () => {
    const { cp, calls } = routedHarness({
      ...registry,
      '/observability/metrics': [
        { service: 'acme-helpdesk-v1', requests: 10, errors: 1, subrequests: 20, cpuTimeP50: 900, cpuTimeP99: 4000 },
        // Another tenant's service in the staff-wide answer — must be dropped, and
        // never surfaced even as an opaque ref.
        { service: 'rival-crm-v9', requests: 99, errors: 0, subrequests: 0, cpuTimeP50: 1, cpuTimeP99: 2 },
      ],
    });
    const rows = await cp.observabilityMetrics(24);
    expect(rows).toEqual([
      {
        service: 'acme-helpdesk-v1',
        vertical: 'acme/helpdesk',
        version: '0.1.0',
        requests: 10,
        errors: 1,
        subrequests: 20,
        cpuTimeP50: 900,
        cpuTimeP99: 4000,
      },
    ]);
    // Only the OWN verticals' versions were enumerated — never the rival's.
    expect(calls.some((u) => u.includes('rival'))).toBe(false);
  });

  it('observabilityLogs answers [] for an unowned service WITHOUT asking the plane', async () => {
    const { cp, calls } = routedHarness(registry);
    expect(await cp.observabilityLogs({ services: ['rival-crm-v9'] })).toEqual([]);
    // The ownership check runs first — the staff-wide log query was never issued.
    expect(calls.some((u) => u.includes('/observability/logs'))).toBe(false);
  });

  it('observabilityLogs drops unowned refs from a multi-service ask, keeping the owned ones', async () => {
    const { cp, calls } = routedHarness({ ...registry, '/observability/logs': [] });
    // The "all versions" ask: a rival ref mixed in must not reach the staff-wide query,
    // and must not poison the owned half of the request either.
    await cp.observabilityLogs({ services: ['acme-helpdesk-v1', 'rival-crm-v9'] });
    const logCall = calls.find((u) => u.includes('/observability/logs'))!;
    expect(logCall).toContain('service=acme-helpdesk-v1');
    expect(logCall).not.toContain('rival');
  });

  it('observabilityLogs queries an owned service with the narrowing params', async () => {
    const { cp, calls } = routedHarness({ ...registry, '/observability/logs': [] });
    await cp.observabilityLogs({ services: ['acme-helpdesk-v1'], level: 'error', search: 'TypeError', hours: 24, limit: 50 });
    const logCall = calls.find((u) => u.includes('/observability/logs'));
    expect(logCall).toContain('service=acme-helpdesk-v1');
    expect(logCall).toContain('level=error');
    expect(logCall).toContain('search=TypeError');
    expect(logCall).toContain('hours=24');
    expect(logCall).toContain('limit=50');
  });

  it('observabilityLogs carries the enriched neutral fields and the `raw` event through (owned service ⇒ own telemetry)', async () => {
    const { cp } = routedHarness({
      ...registry,
      '/observability/logs': [
        {
          timestamp: 1722700000000,
          level: 'error',
          message: 'boom',
          service: 'acme-helpdesk-v1',
          outcome: 'exception',
          trigger: 'default.closeTicket',
          eventType: 'rpc',
          entrypoint: 'ScopeDO',
          requestId: 'YAU1U795U1IUWWRM',
          cpuTimeMs: 3.2,
          wallTimeMs: 5,
          // `raw` is the provider event verbatim. The ownership gate above already
          // proved this service is THIS tenant's, so the event is the tenant's own
          // telemetry — passing it through powers the per-row drill-down, not a leak.
          raw: { $metadata: { trigger: 'default.closeTicket' }, $workers: { outcome: 'exception' } },
        },
      ],
    });
    const events = await cp.observabilityLogs({ services: ['acme-helpdesk-v1'] });
    expect(events).toEqual([
      {
        timestamp: 1722700000000,
        level: 'error',
        message: 'boom',
        service: 'acme-helpdesk-v1',
        outcome: 'exception',
        trigger: 'default.closeTicket',
        eventType: 'rpc',
        entrypoint: 'ScopeDO',
        requestId: 'YAU1U795U1IUWWRM',
        cpuTimeMs: 3.2,
        wallTimeMs: 5,
        raw: { $metadata: { trigger: 'default.closeTicket' }, $workers: { outcome: 'exception' } },
      },
    ]);
  });

  it('observabilityMetrics with a vertical filter keeps that vertical only; an unowned slug never reaches the plane', async () => {
    const twoOwned = {
      '/verticals': {
        entries: [
          { slug: 'acme/helpdesk', name: 'Helpdesk', source: 'cli', ownerTenant: T },
          { slug: 'acme/portal', name: 'Portal', source: 'cli', ownerTenant: T },
          { slug: 'rival/crm', name: 'CRM', source: 'cli', ownerTenant: OTHER },
        ],
        nextCursor: null,
      },
      '/verticals/acme%2Fhelpdesk/versions': registry['/verticals/acme%2Fhelpdesk/versions'],
      '/verticals/acme%2Fportal/versions': {
        entries: [
          { id: 'p1', version: '1.2.0', admission: 'admitted', admissionNote: null, deploymentRef: 'acme-portal-p1', createdAt: 'now' },
        ],
        nextCursor: null,
      },
      '/observability/metrics': [
        { service: 'acme-helpdesk-v1', requests: 10, errors: 1, subrequests: 20, cpuTimeP50: 900, cpuTimeP99: 4000 },
        { service: 'acme-portal-p1', requests: 5, errors: 0, subrequests: 2, cpuTimeP50: 100, cpuTimeP99: 200 },
      ],
    };

    // The per-app tab's filter: the OTHER owned vertical's rows drop out too.
    const filtered = await routedHarness(twoOwned).cp.observabilityMetrics(24, 'acme/portal');
    expect(filtered.map((r) => r.service)).toEqual(['acme-portal-p1']);

    // A vertical this tenant doesn't own (someone else's, or nonsense) narrows the
    // ownership map to nothing — [] without the staff-wide metrics query ever issuing.
    const unowned = routedHarness(twoOwned);
    expect(await unowned.cp.observabilityMetrics(24, 'rival/crm')).toEqual([]);
    expect(unowned.calls.some((u) => u.includes('/observability/metrics'))).toBe(false);
  });

  // The permission-registry read (D-39, #336) the Permissions tab consumes.
  it('versionRegistry reads one version’s declared surface at the right route', async () => {
    const reg = {
      permissions: [{ key: 'helpdesk:ticket-create', description: 'Open a ticket', declaredBy: ['helpdesk'] }],
      roles: [{ key: 'agent', permissions: ['helpdesk:ticket-create'], source: 'vertical' }],
      entityGrants: [],
    };
    const { cp, calls } = harness(200, { registry: reg });
    const out = await cp.versionRegistry('acme/helpdesk', 'ver-1');
    expect(out).toEqual(reg);
    expect(calls[0]!.url).toBe('https://cp/api/verticals/acme%2Fhelpdesk/versions/ver-1/registry');
  });

  it('versionRegistry returns null on a non-200 (unknown/unreadable) rather than throwing', async () => {
    const { cp } = harness(404, { error: 'not found' });
    expect(await cp.versionRegistry('acme/helpdesk', 'ghost')).toBeNull();
  });
});
