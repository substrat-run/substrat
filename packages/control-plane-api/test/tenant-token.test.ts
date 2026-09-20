import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import { platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import {
  createControlPlaneApi,
  firstBuilderAuth,
  mintPushToken,
  mintTenantToken,
  pushActorFor,
  pushTokenBuilderAuth,
  tenantTokenAuth,
  verifyTenantToken,
  DEV_ACTOR_HEADER,
  SERVICE_TOKEN_HEADER,
  TENANT_HEADER,
  UNSAFE_devPlatformActorAuth,
} from '../src/index.js';

/**
 * Tenant tokens (tenant-token.ts) — the dashboard's tenant-scoped service credential,
 * #977.
 *
 * The property under test is NOT "the dashboard sends the right tenant id". That was
 * already true, and it is exactly what the issue says is worth nothing: the narrowing
 * was the caller's promise about itself. What these assert is that **the credential
 * cannot reach another tenant even when the request asks it to** — the refusal comes
 * from the control plane, on a request the dashboard would never make.
 *
 * So every cross-tenant case below is paired with its POSITIVE twin on the same route.
 * Without the twin, deleting the route would pass the negative.
 */
describe('tenant tokens', () => {
  const SECRET = 'test-tenant-token-secret';
  const PUSH_SECRET = 'test-push-token-secret';
  const tA = tenantId.parse(ulid());
  const tB = tenantId.parse(ulid());
  const serviceActor = platformActorId.parse('01JZ00000000000000000000SV');

  it('mints, verifies, and round-trips the claim', async () => {
    const token = await mintTenantToken(SECRET, { tenantId: tA });
    expect(token.startsWith('stt1.')).toBe(true);
    const claim = await verifyTenantToken(SECRET, token);
    expect(claim).not.toBeNull();
    expect(claim!.tenantId).toBe(tA);
  });

  it('carries no actor — a minted token cannot name its own audit subject', async () => {
    const token = await mintTenantToken(SECRET, { tenantId: tA });
    const claim = (await verifyTenantToken(SECRET, token)) as Record<string, unknown>;
    expect(Object.keys(claim).sort()).toEqual(['iat', 'tenantId', 'v']);
    // The audited subject is the host's, handed to the reader — never the token's.
    const identity = await tenantTokenAuth(SECRET, serviceActor)(
      new Request('http://cp/tenants', { headers: { [SERVICE_TOKEN_HEADER]: token } }),
    );
    expect(identity).toEqual({ actor: serviceActor, tenantId: tA });
  });

  it('refuses a tampered payload, a wrong secret, and a foreign prefix', async () => {
    const token = await mintTenantToken(SECRET, { tenantId: tA });
    const [prefix, payload, sig] = token.split('.') as [string, string, string];

    // Another tenant's payload under this one's signature: must not verify.
    const other = await mintTenantToken(SECRET, { tenantId: tB });
    expect(await verifyTenantToken(SECRET, `${prefix}.${other.split('.')[1]!}.${sig}`)).toBeNull();

    expect(await verifyTenantToken('some-other-secret', token)).toBeNull();
    expect(await verifyTenantToken(SECRET, `stt2.${payload}.${sig}`)).toBeNull();
    expect(await verifyTenantToken(SECRET, 'not-even-a-token')).toBeNull();
  });

  it('cannot be replayed as a push token, nor a push token as one — the prefix is signed', async () => {
    // The two credentials share the wire codec, so the thing that keeps them apart is
    // that the prefix is INSIDE the signed input. Under one shared secret (which is
    // exactly what the dedicated-secret rule forbids, and therefore what this proves
    // would not save you) the payloads still do not cross.
    const tenant = await mintTenantToken(SECRET, { tenantId: tA });
    const push = await mintPushToken(SECRET, {
      actor: await pushActorFor(tA),
      tenantId: tA,
      tenantSlug: 'acme',
    });
    const swapped = `stt1.${push.split('.')[1]!}.${push.split('.')[2]!}`;
    expect(await verifyTenantToken(SECRET, swapped)).toBeNull();
    expect(tenant.split('.')[0]).toBe('stt1');
  });

  it('the reader handles only stt1 values in x-service-token, else declines', async () => {
    const auth = tenantTokenAuth(SECRET, serviceActor);
    const withHeader = (v?: string) =>
      new Request('http://cp/tenants', { headers: v ? { [SERVICE_TOKEN_HEADER]: v } : {} });

    // A random-hex platform service token and a CI push token both fall through.
    expect(await auth(withHeader('a'.repeat(64)))).toBeNull();
    expect(
      await auth(
        withHeader(
          await mintPushToken(PUSH_SECRET, { actor: await pushActorFor(tA), tenantId: tA, tenantSlug: 'acme' }),
        ),
      ),
    ).toBeNull();
    expect(await auth(withHeader())).toBeNull();
  });

  describe('over the API', () => {
    let dir: string;
    let host: SqliteScopeHost;
    let app: ReturnType<typeof createControlPlaneApi>;

    const staff = platformActorId.parse(ulid());
    const staffHeaders = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
    const scopeA = scopeId.parse(ulid());
    const scopeB = scopeId.parse(ulid());
    let asA: Record<string, string>;
    let asB: Record<string, string>;

    // A stub script-grain reader that answers for BOTH tenants' services, so the
    // narrowing is the plane's and not the backend's.
    const reader = {
      serviceMetrics: async () => [
        { service: 'acme-app', namespace: null, requests: 10, errors: 0, subrequests: 0, cpuTimeP50: 1, cpuTimeP99: 2 },
        { service: 'rival-app', namespace: null, requests: 99, errors: 9, subrequests: 0, cpuTimeP50: 1, cpuTimeP99: 2 },
      ],
      serviceMetricsSeries: async (input: { services?: string[] }) =>
        (input.services ?? ['acme-app', 'rival-app']).map((service) => ({
          service,
          start: '2026-09-20T00:00:00.000Z',
          bucketMinutes: 60,
          requests: 1,
          errors: 0,
        })),
      recentLogs: async (input: { services?: string[] }) =>
        (input.services ?? ['acme-app', 'rival-app']).map((service) => ({ service, message: 'hi' })),
    };

    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), 'cp-tenant-token-'));
      host = new SqliteScopeHost({ dir });
      app = createControlPlaneApi({
        host,
        authenticate: UNSAFE_devPlatformActorAuth(),
        authenticateTenantService: tenantTokenAuth(SECRET, serviceActor),
        authenticateBuilder: firstBuilderAuth(pushTokenBuilderAuth(PUSH_SECRET)),
        tenantTokenSecret: SECRET,
        pushTokenSecret: PUSH_SECRET,
        observability: reader as never,
      });

      await host.admin.createTenant(staff, { id: tA, slug: 'acme', name: 'Acme' });
      await host.admin.createTenant(staff, { id: tB, slug: 'rival', name: 'Rival' });
      await host.provisionScope(staff, { tenantId: tA, scopeId: scopeA, vertical: null });
      await host.provisionScope(staff, { tenantId: tB, scopeId: scopeB, vertical: null });
      await host.admin.registerVertical(staff, {
        slug: 'acme/app', name: 'Acme App', source: 'cli', ownerTenant: tA,
      });
      await host.admin.registerVertical(staff, {
        slug: 'rival/app', name: 'Rival App', source: 'cli', ownerTenant: tB,
      });
      // One admitted version each, so the service map has a ref per tenant.
      for (const [slug, ref] of [['acme/app', 'acme-app'], ['rival/app', 'rival-app']] as const) {
        const id = ulid();
        await host.admin.publishVersion(staff, {
          id, verticalSlug: slug, version: '1.0.0',
          manifestDigest: 'm', permissionDigest: 'p', migrationDigest: 'g', deploymentRef: ref,
        });
        await host.admin.admitVersion(staff, id);
      }

      const mintFor = async (t: string): Promise<Record<string, string>> => {
        const res = await app.request('/tenant-tokens', {
          method: 'POST', headers: staffHeaders, body: JSON.stringify({ tenantId: t }),
        });
        expect(res.status).toBe(201);
        const { token } = (await res.json()) as { token: string };
        return { [SERVICE_TOKEN_HEADER]: token, 'content-type': 'application/json' };
      };
      asA = await mintFor(tA);
      asB = await mintFor(tB);
    });

    afterAll(async () => {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    });

    // -- the property: the plane refuses, not the dashboard ------------------

    it('REFUSES a request naming another tenant in the path — and allows its own', async () => {
      // The whole issue in two lines. Tenant A's credential, asked for tenant B's
      // directory row: refused HERE, by the control plane, on a request no correct
      // dashboard would send. Before #977 this was a 200 with B's row in it.
      const foreign = await app.request(`/tenants/${tB}`, { headers: asA });
      expect(foreign.status).toBe(403);

      // The positive twin: the same credential, the same route, its own tenant.
      const own = await app.request(`/tenants/${tA}`, { headers: asA });
      expect(own.status).toBe(200);
      expect((await own.json()).slug).toBe('acme');
    });

    it('REFUSES a foreign tenant on a scope read — and allows its own', async () => {
      expect((await app.request(`/tenants/${tB}/scopes/${scopeB}`, { headers: asA })).status).toBe(403);
      const own = await app.request(`/tenants/${tA}/scopes/${scopeA}`, { headers: asA });
      expect(own.status).toBe(200);
    });

    it('REFUSES a foreign tenant on a destructive write — and allows its own', async () => {
      // Retire (#1593) reaps a scope, which wipes storage. Its tenant narrowing lived
      // entirely in the dashboard worker; this is the plane refusing it.
      const foreign = await app.request(`/tenants/${tB}/scopes/${scopeB}/archive`, {
        method: 'POST', headers: asA,
      });
      expect(foreign.status).toBe(403);
      expect((await host.admin.getScopeRecord(staff, tB, scopeB))!.status).not.toBe('archived');

      const own = await app.request(`/tenants/${tA}/scopes/${scopeA}/archive`, {
        method: 'POST', headers: asA,
      });
      expect(own.status).toBe(200);
      expect((await host.admin.getScopeRecord(staff, tA, scopeA))!.status).toBe('archived');
    });

    it('REFUSES a foreign tenant in a QUERY — and allows its own', async () => {
      expect((await app.request(`/admin-log?tenantId=${tB}`, { headers: asA })).status).toBe(403);
      expect((await app.request(`/admin-log?tenantId=${tA}`, { headers: asA })).status).toBe(200);
    });

    it('lists only its own installs — the Data tab and Move/Retire read this', async () => {
      // `GET /scopes` is the seam's busiest read and the only scope route that names
      // its tenant in a query rather than the path. The plane forces the filter from
      // the principal, so the query cannot widen it — and naming another tenant is
      // refused outright rather than quietly narrowed.
      const own = await app.request(`/scopes?tenantId=${tA}`, { headers: asA });
      expect(own.status).toBe(200);
      const ids = (await own.json()).entries.map((s: { id: string }) => s.id);
      expect(ids).toContain(scopeA);
      expect(ids).not.toContain(scopeB);

      expect((await app.request(`/scopes?tenantId=${tB}`, { headers: asA })).status).toBe(403);
      expect((await app.request('/scopes', { headers: asA })).status).toBe(403);
    });

    it('REFUSES an unnarrowed read — a missing filter is not a fleet answer', async () => {
      // The forced-filter routes answer fleet-wide when `tenantId` is absent. For this
      // credential absent is a refusal, not a default, because "I forgot the filter"
      // and "give me everything" are the same request on the wire.
      expect((await app.request('/admin-log', { headers: asA })).status).toBe(403);
      expect((await app.request('/ops-failures', { headers: asA })).status).toBe(403);
      expect((await app.request(`/ops-failures?tenantId=${tA}`, { headers: asA })).status).toBe(200);
    });

    it('REFUSES a foreign tenant in a BODY — and allows its own', async () => {
      const foreign = await app.request('/scopes', {
        method: 'POST', headers: asA,
        body: JSON.stringify({ tenantId: tB, scopeId: ulid(), slug: 'stolen' }),
      });
      expect(foreign.status).toBe(403);

      const mine = scopeId.parse(ulid());
      const own = await app.request('/scopes', {
        method: 'POST', headers: asA,
        body: JSON.stringify({ tenantId: tA, scopeId: mine, slug: 'mine' }),
      });
      expect(own.status).toBe(201);
    });

    it('REFUSES a caller-asserted tenant header that disagrees with the credential', async () => {
      // The pre-#977 shape: a fleet credential plus `x-substrat-tenant`. Presenting the
      // header is fine — the CLI and the dashboard both send it — but it can only ever
      // repeat what the credential already says.
      const lying = await app.request(`/tenants/${tA}`, { headers: { ...asA, [TENANT_HEADER]: tB } });
      expect(lying.status).toBe(403);
      const honest = await app.request(`/tenants/${tA}`, { headers: { ...asA, [TENANT_HEADER]: tA } });
      expect(honest.status).toBe(200);
    });

    // -- it is not staff -----------------------------------------------------

    it('is NOT staff: the fleet list and every unlisted route are refused', async () => {
      // The fleet tenant list is the one-line version of what a staff token is.
      expect((await app.request('/tenants', { headers: asA })).status).toBe(403);
      // Admission, the marketplace listing flip, members — none of them are on the
      // allowlist, so forgetting one costs a dashboard feature and never reach.
      const admit = await app.request(`/verticals/${encodeURIComponent('acme/app')}/versions/${ulid()}/admit`, {
        method: 'POST', headers: asA,
      });
      expect(admit.status).toBe(403);
    });

    it('cannot mint another credential — not for anyone, not for itself', async () => {
      // The mint is staff-only on BOTH allowlists. If it were not, the confinement
      // would be advisory: a token could hand itself a different tenant's.
      for (const t of [tB, tA]) {
        const res = await app.request('/tenant-tokens', {
          method: 'POST', headers: asA, body: JSON.stringify({ tenantId: t }),
        });
        expect(res.status).toBe(403);
      }
    });

    it('CAN mint the CI push token for its own tenant, and not for another', async () => {
      const own = await app.request('/push-tokens', {
        method: 'POST', headers: asA, body: JSON.stringify({ tenantId: tA }),
      });
      expect(own.status).toBe(201);
      const foreign = await app.request('/push-tokens', {
        method: 'POST', headers: asA, body: JSON.stringify({ tenantId: tB }),
      });
      expect(foreign.status).toBe(403);
    });

    // -- ownership narrowing, where the tenant is a registry fact -------------

    it('reads its own vertical and hides another tenant’s as absent', async () => {
      const own = await app.request(`/verticals/${encodeURIComponent('acme/app')}/versions`, { headers: asA });
      expect(own.status).toBe(200);
      expect((await own.json()).entries).toHaveLength(1);

      // 404, not 403: a slug this tenant does not own reads as absent (K-3).
      const foreign = await app.request(`/verticals/${encodeURIComponent('rival/app')}/versions`, { headers: asA });
      expect(foreign.status).toBe(404);
    });

    it('cannot DELETE another tenant’s vertical', async () => {
      const foreign = await app.request(`/verticals/${encodeURIComponent('rival/app')}`, {
        method: 'DELETE', headers: asA,
      });
      expect(foreign.status).toBe(404);
      expect((await host.admin.listVerticals(staff)).some((v) => v.slug === 'rival/app')).toBe(true);
    });

    it('lists only its own registry slice, and the published catalog', async () => {
      const mine = await app.request(`/verticals?ownerTenant=${tA}`, { headers: asA });
      expect(mine.status).toBe(200);
      expect((await mine.json()).entries.map((v: { slug: string }) => v.slug)).toEqual(['acme/app']);
      // Asking for the whole registry, or for the rival's slice, is refused rather
      // than quietly narrowed — the dashboard used to page everything and filter.
      expect((await app.request('/verticals', { headers: asA })).status).toBe(403);
      expect((await app.request(`/verticals?ownerTenant=${tB}`, { headers: asA })).status).toBe(403);
    });

    // -- script-grain observability: a fleet read, narrowed on the plane ------

    it('sees only its own services’ telemetry, on a route that takes no tenant', async () => {
      const metrics = await app.request('/observability/metrics?hours=1', { headers: asA });
      expect(metrics.status).toBe(200);
      expect((await metrics.json()).map((r: { service: string }) => r.service)).toEqual(['acme-app']);

      // The rival's credential sees the mirror image — so the filter is the pin, not
      // a constant that happens to match.
      const theirs = await app.request('/observability/metrics?hours=1', { headers: asB });
      expect((await theirs.json()).map((r: { service: string }) => r.service)).toEqual(['rival-app']);

      // Naming someone else's script explicitly answers nothing, not their lines.
      const logs = await app.request('/observability/logs?service=rival-app', { headers: asA });
      expect(logs.status).toBe(200);
      expect(await logs.json()).toEqual([]);

      const series = await app.request('/observability/metrics-series?service=rival-app&service=acme-app', {
        headers: asA,
      });
      expect((await series.json()).map((r: { service: string }) => r.service)).toEqual(['acme-app']);
    });

    // -- the mint route ------------------------------------------------------

    it('mints for a tenant that does not exist yet — that IS the sign-up bootstrap', async () => {
      // The dashboard's FIRST call for a new team is `ensureTenant`, over this same
      // seam. A mint that required the directory row would make that unreachable: no
      // row, no credential, no way to create the row. So it mints, and what the
      // credential can do until the row exists is create exactly that row.
      const fresh = tenantId.parse(ulid());
      const minted = await app.request('/tenant-tokens', {
        method: 'POST', headers: staffHeaders, body: JSON.stringify({ tenantId: fresh }),
      });
      expect(minted.status).toBe(201);
      const asFresh = {
        [SERVICE_TOKEN_HEADER]: ((await minted.json()) as { token: string }).token,
        'content-type': 'application/json',
      };

      // It reaches nothing — including the tenant it is FOR, which has no rows yet.
      expect((await app.request(`/tenants/${fresh}`, { headers: asFresh })).status).toBe(404);
      // …and it still cannot name anybody else's.
      expect((await app.request(`/tenants/${tA}`, { headers: asFresh })).status).toBe(403);
      const stealing = await app.request('/tenants', {
        method: 'POST', headers: asFresh,
        body: JSON.stringify({ id: tenantId.parse(ulid()), slug: 'not-mine', name: 'Not Mine' }),
      });
      expect(stealing.status).toBe(403);

      // What it CAN do: bootstrap its own row, and then act inside it.
      const bootstrap = await app.request('/tenants', {
        method: 'POST', headers: asFresh,
        body: JSON.stringify({ id: fresh, slug: 'fresh-co', name: 'Fresh Co' }),
      });
      expect(bootstrap.status).toBe(201);
      expect((await app.request(`/tenants/${fresh}`, { headers: asFresh })).status).toBe(200);
    });

    it('501s the mint when no secret is configured', async () => {
      const bare = createControlPlaneApi({ host, authenticate: UNSAFE_devPlatformActorAuth() });
      const res = await bare.request('/tenant-tokens', {
        method: 'POST', headers: staffHeaders, body: JSON.stringify({ tenantId: tA }),
      });
      expect(res.status).toBe(501);
    });

    it('leaves staff and builder principals exactly as they were', async () => {
      // The fleet list, the whole registry, another tenant's row: all still staff's.
      expect((await app.request('/tenants', { headers: staffHeaders })).status).toBe(200);
      expect((await app.request(`/tenants/${tB}`, { headers: staffHeaders })).status).toBe(200);
      expect((await app.request('/observability/metrics?hours=1', { headers: staffHeaders })).status).toBe(200);
      expect(
        ((await (await app.request('/observability/metrics?hours=1', { headers: staffHeaders })).json()) as unknown[])
          .length,
      ).toBe(2);

      // A CI push token is still a builder: its own verticals, nothing else.
      const ci = await mintPushToken(PUSH_SECRET, {
        actor: await pushActorFor(tA), tenantId: tA, tenantSlug: 'acme',
      });
      const asCi = { [SERVICE_TOKEN_HEADER]: ci, 'content-type': 'application/json' };
      expect((await app.request('/tenants', { headers: asCi })).status).toBe(403);
      const owned = await app.request('/verticals', { headers: asCi });
      expect(owned.status).toBe(200);
      expect((await owned.json()).entries.map((v: { slug: string }) => v.slug)).toEqual(['acme/app']);
    });
  });
});
