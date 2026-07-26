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
    '/verticals': [
      { slug: 'acme/helpdesk', name: 'Helpdesk', source: 'cli', ownerTenant: T },
      { slug: 'rival/crm', name: 'CRM', source: 'cli', ownerTenant: OTHER },
    ],
    '/verticals/acme%2Fhelpdesk/versions': [
      { id: 'v1', version: '0.1.0', admission: 'admitted', admissionNote: null, deploymentRef: 'acme-helpdesk-v1', createdAt: 'now' },
      { id: 'v0', version: '0.0.9', admission: 'admitted', admissionNote: null, deploymentRef: null, createdAt: 'now' },
    ],
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
    expect(await cp.observabilityLogs({ service: 'rival-crm-v9' })).toEqual([]);
    // The ownership check runs first — the staff-wide log query was never issued.
    expect(calls.some((u) => u.includes('/observability/logs'))).toBe(false);
  });

  it('observabilityLogs queries an owned service with the narrowing params', async () => {
    const { cp, calls } = routedHarness({ ...registry, '/observability/logs': [] });
    await cp.observabilityLogs({ service: 'acme-helpdesk-v1', level: 'error', hours: 24, limit: 50 });
    const logCall = calls.find((u) => u.includes('/observability/logs'));
    expect(logCall).toContain('service=acme-helpdesk-v1');
    expect(logCall).toContain('level=error');
    expect(logCall).toContain('hours=24');
    expect(logCall).toContain('limit=50');
  });
});
