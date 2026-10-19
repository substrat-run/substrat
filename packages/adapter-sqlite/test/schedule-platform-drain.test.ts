import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPlatformRequest, platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { runPlatformSweep, ulid, type FetchLike } from '@substrat-run/kernel';
import { SCHED_REQUEST_KIND, schedRequestMod } from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';

/**
 * #2431, end to end on a real host: a sweep whose schedules enqueue platform requests drains them
 * in the same pass. The drain here is a stand-in for the control plane's: it reads the scope's
 * pending journal through the host and settles each row `done`, so what it saw is what the
 * schedules had committed by then.
 */
describe('a sweep drains what its schedules just enqueued (#2431)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-sched-drain-'));
  const host = new SqliteScopeHost({ dir });
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  /** The scheduled requests each drain call found pending, in call order. */
  const seen: number[][] = [];

  const sweep = () =>
    runPlatformSweep(host, {
      actor: staff,
      fetch: (() => Promise.reject(new Error('unused'))) as unknown as FetchLike,
      sweepers: {},
      drainRetries: false,
      gcSnapshots: false,
      reconcileMigrations: false,
      drainPlatformRequestsFn: async (tenant, scope) => {
        const pending = (await host.listPlatformRequests(tenant, scope)).filter(isPlatformRequest);
        seen.push(pending.filter((r) => r.kind === SCHED_REQUEST_KIND).map((r) => (r.payload as { n: number }).n).sort());
        for (const r of pending) await host.settlePlatformRequest(tenant, scope, r.id, { status: 'done' });
        return { drained: pending.length, done: pending.length, failed: 0, pending: 0 };
      },
    });

  beforeAll(async () => {
    host.registerModule(schedRequestMod);
    await host.admin.createTenant(staff, { id: t, slug: `sched-drain-${t.toLowerCase()}`, name: 'Scheduled drain' });
    await host.admin.grantEntitlement(staff, t, 'sched');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'sched-request-vertical' });
    await host.admin.activateScope(staff, t, s);
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('the drain after the schedules executes their requests, and the pass leaves nothing pending', async () => {
    const report = await sweep();
    // Before the schedules there was nothing; after them, the two the fires committed.
    expect(seen).toEqual([[], [1, 2]]);
    expect(report.schedules).toMatchObject({ fired: 1, failed: 1, platformRequests: 2 });
    expect(report.platformRequestTotals).toMatchObject({ scopes: 1, drained: 2, done: 2, pending: 0 });
    expect((await host.listPlatformRequests(t, s)).filter(isPlatformRequest)).toEqual([]);
  });

  it('a pass whose schedules fire nothing drains the scope once (the twin)', async () => {
    seen.length = 0;
    const report = await sweep();
    expect(seen).toEqual([[]]);
    expect(report.schedules?.platformRequests).toBeUndefined();
  });
});
