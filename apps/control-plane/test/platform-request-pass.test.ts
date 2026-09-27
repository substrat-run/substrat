import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';
import { platformActorId } from '@substrat-run/contracts';
import { ulid, type PlatformSweepReport } from '@substrat-run/kernel';
import worker, { platformRequestSweepRun } from '../src/worker.js';
import { warmControlPlane } from './do-warmup.js';

/**
 * #1840 — the scheduled pass keeps the platform-intent drain's totals, as ONE
 * `platform-request` sweep row per pass, so `GET /platform-requests/backlog` can say how
 * many intents are still waiting without walking the fleet itself.
 *
 * Driven through the worker's real `scheduled` handler against the real directory Durable
 * Object, so the write is proven on workerd's SQLite (the new column included), not only
 * on node's. The directory persists across this pool's files, so every assertion is about
 * rows newer than the pass this file started.
 */
describe('the scheduled pass records the drain as a platform-request row (#1840)', () => {
  const staff = platformActorId.parse(ulid());
  const hostOf = () => new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
  const newest = async () =>
    (await hostOf().admin.listSweepRuns(staff, { kind: 'platform-request', unit: 'fleet', limit: 1 }))[0];

  beforeAll(async () => {
    await warmControlPlane(env.CONTROL_PLANE);
  });

  it('writes one fleet row carrying the totals, every pass', async () => {
    const before = new Date().toISOString();
    await worker.scheduled({} as ScheduledController, env as never);
    const first = await newest();
    expect(first).toBeDefined();
    expect(first!.at >= before).toBe(true);
    expect(first).toMatchObject({ kind: 'platform-request', unit: 'fleet', tenantId: null, scopeId: null });
    expect(first!.platformRequests).toEqual({
      scopes: expect.any(Number),
      drained: expect.any(Number),
      done: expect.any(Number),
      failed: expect.any(Number),
      pending: expect.any(Number),
      skipped: expect.any(Number),
      unreachable: expect.any(Number),
    });

    // A second pass writes a second row — an idle pass included, or an older count would
    // stand as the answer.
    await worker.scheduled({} as ScheduledController, env as never);
    const second = await newest();
    expect(second!.id).not.toBe(first!.id);
    expect(second!.at >= first!.at).toBe(true);
  });
});

describe('platformRequestSweepRun (#1840)', () => {
  const AT = '2026-09-27T12:00:00.000Z';
  const totals = { scopes: 2, drained: 6, done: 3, failed: 1, pending: 2, skipped: 0, unreachable: 0 };
  const report = (over: Partial<PlatformSweepReport> = {}): PlatformSweepReport =>
    ({ platformRequestTotals: totals, errors: [], migrations: null, ...over }) as PlatformSweepReport;

  it('a pass that reached every scope is ok, with the totals as they were, stamped with the time it is given', () => {
    expect(platformRequestSweepRun(report(), AT)).toEqual({
      kind: 'platform-request',
      unit: 'fleet',
      outcome: 'ok',
      error: null,
      platformRequests: totals,
      at: AT,
    });
  });

  it('a scope whose drain threw makes the count a floor', () => {
    const run = platformRequestSweepRun(report({ errors: [{ kind: 'platform-request', id: 's1', error: 'boom' }] }), AT);
    expect(run.outcome).toBe('failed');
    expect(run.error).toMatch(/1 scope drain\(s\) failed/);
  });

  it('so does an ACTIVE scope the drain stepped over for a failed migration', () => {
    const run = platformRequestSweepRun(report({ platformRequestTotals: { ...totals, skipped: 1 } }), AT);
    expect(run.outcome).toBe('failed');
    expect(run.error).toMatch(/1 scope\(s\) skipped for a failed migration/);
  });

  it('a failed PROVISIONING scope does not — the drain never visits one, so nothing is missing', () => {
    // `migrations.failed` counts it; the drain's own `skipped` does not, and only that is read.
    const run = platformRequestSweepRun(
      report({ migrations: { failed: 1 } as PlatformSweepReport['migrations'], platformRequestTotals: { ...totals, skipped: 0 } }),
      AT,
    );
    expect(run.outcome).toBe('ok');
  });

  it('a scope with no reachable deployment makes the count a floor, and says why', () => {
    const run = platformRequestSweepRun(report({ platformRequestTotals: { ...totals, unreachable: 2 } }), AT);
    expect(run.outcome).toBe('failed');
    expect(run.error).toMatch(/2 scope\(s\) had no reachable deployment/);
  });

  it("another phase's error does not — it says nothing about the drain's reach", () => {
    expect(platformRequestSweepRun(report({ errors: [{ kind: 'sweep', id: 'c1', error: 'boom' }] }), AT).outcome).toBe('ok');
  });
});
