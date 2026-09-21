import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import { platformActorId, scopeId, tenantId, type ScopeId, type ScopeStatus } from '@substrat-run/contracts';
import {
  createControlPlaneApi,
  mintTenantToken,
  readStoragePage,
  tenantTokenAuth,
  DEV_ACTOR_HEADER,
  SERVICE_TOKEN_HEADER,
  STORAGE_PAGE_MAX,
  STORAGE_READ_CONCURRENCY,
  UNSAFE_devPlatformActorAuth,
  VerticalClient,
} from '../src/index.js';

/**
 * The on-demand storage reading (#1524). Each scope it reads is a Durable Object it
 * wakes, so the tests below are about cost and honesty. How many wakes one request can
 * cause, how many run at once, and whether a sum that is missing a scope can ever be
 * read as the tenant's total.
 */

const T = tenantId.parse(ulid());
const AT = '2026-09-21T09:00:00.000Z';
const scopesOf = (n: number, status: ScopeStatus = 'active') =>
  Array.from({ length: n }, () => ({ scopeId: scopeId.parse(ulid()), status }));

describe('readStoragePage — the bounds (#1524)', () => {
  it('reads at most one page of scopes per call, and resumes after the cursor', async () => {
    const scopes = scopesOf(STORAGE_PAGE_MAX + 5);
    const touched = new Set<ScopeId>();
    const read = async (s: { scopeId: ScopeId }) => {
      touched.add(s.scopeId);
      return 4096;
    };
    // A limit above the cap is clamped: one card-open can never wake more than the cap.
    const first = await readStoragePage({ tenantId: T, readAt: AT, scopes, limit: 10_000, read });
    expect(first.scopes).toHaveLength(STORAGE_PAGE_MAX);
    expect(touched.size).toBe(STORAGE_PAGE_MAX);
    expect(first.total).toBe(STORAGE_PAGE_MAX + 5);
    expect(first.nextCursor).not.toBeNull();
    expect(first.complete).toBe(false);

    const rest = await readStoragePage({ tenantId: T, readAt: AT, scopes, cursor: first.nextCursor!, read });
    expect(rest.scopes).toHaveLength(5);
    expect(rest.nextCursor).toBeNull();
    // Every scope read exactly once across the two pages, none twice.
    expect(touched.size).toBe(STORAGE_PAGE_MAX + 5);
    expect(new Set([...first.scopes, ...rest.scopes].map((s) => s.scopeId)).size).toBe(STORAGE_PAGE_MAX + 5);
    // A later page is never "complete", even when it read cleanly to the end. It does not
    // cover the pages before it, so it cannot be the tenant's total on its own.
    expect(rest.complete).toBe(false);
  });

  it('never has more than the concurrency cap in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const read = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight -= 1;
      return 1;
    };
    const page = await readStoragePage({ tenantId: T, readAt: AT, scopes: scopesOf(40), limit: 40, read, concurrency: 1000 });
    expect(page.read).toBe(40);
    expect(peak).toBe(STORAGE_READ_CONCURRENCY);
  });

  it('says a sum is partial when one read fails, and never counts the failure as zero', async () => {
    const scopes = scopesOf(3);
    const bad = scopes[1]!.scopeId;
    const read = async (s: { scopeId: ScopeId }) => {
      if (s.scopeId === bad) throw new Error('DO unreachable');
      return 1000;
    };
    const page = await readStoragePage({ tenantId: T, readAt: AT, scopes, read });
    expect(page.bytes).toBe(2000);
    expect(page.read).toBe(2);
    expect(page.failed).toBe(1);
    expect(page.complete).toBe(false);
    expect(page.scopes.find((s) => s.scopeId === bad)).toMatchObject({ bytes: null, error: 'DO unreachable' });

    // The positive twin: the same scopes, every read answering, is the complete total.
    const clean = await readStoragePage({ tenantId: T, readAt: AT, scopes, read: async () => 1000 });
    expect(clean).toMatchObject({ bytes: 3000, read: 3, failed: 0, complete: true, nextCursor: null });
  });

  it('refuses a reader answer that is not a size, instead of summing it', async () => {
    const page = await readStoragePage({ tenantId: T, readAt: AT, scopes: scopesOf(2), read: async () => Number.NaN });
    expect(page).toMatchObject({ bytes: 0, failed: 2, complete: false });
  });

  it('counts reaped scopes without reading them, and names what it excludes', async () => {
    const live = scopesOf(2);
    const gone = scopesOf(3, 'reaped');
    const read = async (s: { status: ScopeStatus }) => {
      if (s.status === 'reaped') throw new Error('read a reaped scope');
      return 10;
    };
    const page = await readStoragePage({ tenantId: T, readAt: AT, scopes: [...gone, ...live], read });
    expect(page).toMatchObject({ total: 2, reaped: 3, read: 2, failed: 0, bytes: 20, complete: true });
    expect(page.basis).toBe('scope-databases');
    expect(page.excluded).toEqual(['attachments', 'tenant-stores', 'lake']);
  });
});

describe('GET /meters/storage (#1524)', () => {
  const SECRET = 'storage-meter-tenant-secret';
  const serviceActor = platformActorId.parse('01JZ00000000000000000000SV');
  const staff = platformActorId.parse(ulid());
  const acme = tenantId.parse(ulid());
  const builderActor = platformActorId.parse(ulid());
  const colocated = scopeId.parse(ulid());
  const onVertical = scopeId.parse(ulid());
  const orphaned = scopeId.parse(ulid());
  const BUILDER_HEADER = 'x-test-builder';
  const asStaff = { [DEV_ACTOR_HEADER]: staff };

  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;
  const verticalReads: string[] = [];
  const fakeVertical = {
    databaseSize: async (s: ScopeId) => {
      verticalReads.push(s);
      return 777_000;
    },
  } as unknown as VerticalClient;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-storage-'));
    host = new SqliteScopeHost({ dir });
    app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      authenticateTenantService: tenantTokenAuth(SECRET, serviceActor),
      authenticateBuilder: (req: Request) =>
        req.headers.get(BUILDER_HEADER) === acme ? { actor: builderActor, tenantId: acme, tenantSlug: 'acme' } : null,
      verticals: { 'demo-vert': fakeVertical },
    });
    await host.admin.createTenant(staff, { id: acme, slug: 'acme', name: 'Acme' });
    await host.provisionScope(staff, { tenantId: acme, scopeId: colocated, vertical: null });
    await host.provisionScope(staff, { tenantId: acme, scopeId: onVertical, vertical: 'demo-vert' });
    await host.provisionScope(staff, { tenantId: acme, scopeId: orphaned, vertical: 'nobody-deploys-this' });
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads each scope where its data lives, and marks the sum partial when one cannot be read', async () => {
    const res = await app.request(`/meters/storage?tenantId=${acme}`, { headers: asStaff });
    expect(res.status).toBe(200);
    const body = await res.json();
    const by = new Map<string, { bytes: number | null; error?: string }>(body.scopes.map((s: { scopeId: string }) => [s.scopeId, s]));

    // Co-located: the host's own database, a real SQLite size.
    const local = by.get(colocated)!;
    expect(local.bytes).toBe(await host.admin.scopeDatabaseSize(staff, acme, colocated));
    // On a vertical: read through that deployment, never the co-located host.
    expect(by.get(onVertical)!.bytes).toBe(777_000);
    expect(verticalReads).toEqual([onVertical]);
    // A vertical nothing deploys fails for that scope. The co-located host would answer
    // with a database that is not the scope's, so there is no fallback to it.
    expect(by.get(orphaned)).toMatchObject({ bytes: null, error: expect.stringMatching(/nobody-deploys-this/) });

    expect(body).toMatchObject({ total: 3, read: 2, failed: 1, complete: false, nextCursor: null });
    expect(body.bytes).toBe(local.bytes! + 777_000);
  });

  it('pages: a limit wakes at most that many scopes, and the cursor resumes', async () => {
    verticalReads.length = 0;
    const first = await (await app.request(`/meters/storage?tenantId=${acme}&limit=1`, { headers: asStaff })).json();
    expect(first.scopes).toHaveLength(1);
    expect(first.nextCursor).toBe(first.scopes[0].scopeId);
    const second = await (
      await app.request(`/meters/storage?tenantId=${acme}&limit=1&cursor=${first.nextCursor}`, { headers: asStaff })
    ).json();
    expect(second.scopes).toHaveLength(1);
    expect(second.scopes[0].scopeId > first.scopes[0].scopeId).toBe(true);
    // Out of range is refused at the boundary, not clamped into a bigger fan-out.
    expect((await app.request(`/meters/storage?tenantId=${acme}&limit=${STORAGE_PAGE_MAX + 1}`, { headers: asStaff })).status).toBe(400);
  });

  it('has no fleet-wide form: a reading names its tenant', async () => {
    expect((await app.request('/meters/storage', { headers: asStaff })).status).toBe(400);
    expect((await app.request('/meters/storage?tenantId=not-a-ulid', { headers: asStaff })).status).toBe(400);
  });

  it('is staff-only: a builder and a tenant token are refused, even for their own tenant', async () => {
    const url = `/meters/storage?tenantId=${acme}`;
    const builder = await app.request(url, { headers: { [BUILDER_HEADER]: acme } });
    expect(builder.status).toBe(403);
    const token = await mintTenantToken(SECRET, { tenantId: acme });
    const tenant = await app.request(url, { headers: { [SERVICE_TOKEN_HEADER]: token } });
    expect(tenant.status).toBe(403);
    expect((await app.request(url)).status).toBe(401);
    // The positive twin for both credentials: they are real, and they reach a route
    // their allowlist does name. The refusal above is this route's, not a bad credential.
    expect((await app.request('/scopes', { headers: { [BUILDER_HEADER]: acme } })).status).toBe(200);
    expect((await app.request(`/tenants/${acme}`, { headers: { [SERVICE_TOKEN_HEADER]: token } })).status).toBe(200);
  });
});

describe('GET /meters/storage on a plane with no verticals (#1524)', () => {
  it('reads a vertical-named scope from the co-located host, the only place it can live', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-storage-solo-'));
    const host = new SqliteScopeHost({ dir });
    try {
      const staff = platformActorId.parse(ulid());
      const t = tenantId.parse(ulid());
      const s = scopeId.parse(ulid());
      const app = createControlPlaneApi({ host, authenticate: UNSAFE_devPlatformActorAuth() });
      await host.admin.createTenant(staff, { id: t, slug: 'solo', name: 'Solo' });
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'todo' });
      const body = await (await app.request(`/meters/storage?tenantId=${t}`, { headers: { [DEV_ACTOR_HEADER]: staff } })).json();
      expect(body).toMatchObject({ total: 1, read: 1, failed: 0, complete: true });
      expect(body.bytes).toBeGreaterThan(0);
    } finally {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
