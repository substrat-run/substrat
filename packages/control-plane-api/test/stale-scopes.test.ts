import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { runPlatformSweep, ulid, type FetchLike } from '@substrat-run/kernel';
import { platformActorId, scopeId, staleScopesReading, tenantId } from '@substrat-run/contracts';
import { createControlPlaneApi, DEV_ACTOR_HEADER, UNSAFE_devPlatformActorAuth } from '../src/index.js';

/**
 * `GET /stale-scopes` (#3313): the report the platform sweep takes into the directory, served back
 * to staff. The sweep runs for real over a real SQLite directory, so the route is held to what the
 * report wrote. Which scopes each finding names is the contract suite's to hold.
 */
describe('GET /stale-scopes (#3313)', () => {
  const staff = platformActorId.parse(ulid());
  const builderActor = platformActorId.parse(ulid());
  const BUILDER_HEADER = 'x-test-builder';
  const A = tenantId.parse(ulid());
  const unreachable = scopeId.parse(ulid());
  const stuck = scopeId.parse(ulid());
  let dir: string;
  let host: SqliteScopeHost;
  let app: ReturnType<typeof createControlPlaneApi>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-stale-scopes-'));
    host = new SqliteScopeHost({ dir });
    app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      authenticateBuilder: (req: Request) =>
        req.headers.get(BUILDER_HEADER) === A ? { actor: builderActor, tenantId: A, tenantSlug: 'acme' } : null,
    });
    await host.admin.createTenant(staff, { id: A, slug: 'acme', name: 'Acme' });
    await host.provisionScope(staff, { tenantId: A, scopeId: unreachable });
    await host.admin.activateScope(staff, A, unreachable);
    await host.provisionScope(staff, { tenantId: A, scopeId: stuck });
    // Two days on, so the scope left provisioning is stuck by then.
    const now = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const report = await runPlatformSweep(host, {
      actor: staff,
      fetch: (() => Promise.reject(new Error('unused'))) as unknown as FetchLike,
      sweepers: {},
      drainRetries: false,
      staleScopes: { now: () => now },
    });
    expect(report.staleScopes).toMatchObject({ taken: true });
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves the findings to staff, filtered by finding, with the latest report; anyone else is refused', async () => {
    const res = await app.request(`/stale-scopes?tenantId=${A}`, { headers: { [DEV_ACTOR_HEADER]: staff } });
    expect(res.status).toBe(200);
    const body = staleScopesReading.parse(await res.json());
    expect(body.findings.map((f) => [f.scopeId, f.finding, f.tenantSlug]).sort()).toEqual(
      [
        [stuck, 'stuck-provisioning', 'acme'],
        [unreachable, 'unreachable', 'acme'],
      ].sort(),
    );
    expect(body).toMatchObject({ truncated: false, latest: { findings: expect.any(Number), idleJudged: false } });

    const one = staleScopesReading.parse(
      await (await app.request('/stale-scopes?finding=unreachable&limit=1', { headers: { [DEV_ACTOR_HEADER]: staff } })).json(),
    );
    expect(one.findings.map((f) => f.finding)).toEqual(['unreachable']);
    expect((await app.request('/stale-scopes?finding=forgotten', { headers: { [DEV_ACTOR_HEADER]: staff } })).status).toBe(400);
    expect((await app.request('/stale-scopes', { headers: { [BUILDER_HEADER]: A } })).status).toBe(403);
  });
});
