import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';
import { platformActorId } from '@substrat-run/contracts';
import { ulid, type PlatformSweepReport } from '@substrat-run/kernel';
import worker, { drainTarget, platformRequestSweepRun, recordPlatformRequestPass, timedDrain } from '../src/worker.js';
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
    const after = new Date().toISOString();
    const first = await newest();
    expect(first).toBeDefined();
    // Stamped inside the pass — the drain phase's end, never a time outside it.
    expect(first!.at >= before && first!.at <= after).toBe(true);
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

describe('recordPlatformRequestPass (#1840)', () => {
  const report = {
    platformRequestTotals: { scopes: 0, drained: 0, done: 0, failed: 0, pending: 0, skipped: 0, unreachable: 0 },
    errors: [],
    migrations: null,
  } as unknown as PlatformSweepReport;
  const AT = '2026-09-27T12:00:00.000Z';

  it('a recorder that throws does not sink the pass', async () => {
    const admin = { recordSweepRun: async () => { throw new Error('directory down'); } };
    await expect(recordPlatformRequestPass(admin, report, AT)).resolves.toBeUndefined();
  });

  it('a recorder that works is handed the row, awaited — the twin', async () => {
    const written: unknown[] = [];
    const admin = { recordSweepRun: async (e: unknown) => { written.push(e); } };
    await recordPlatformRequestPass(admin, report, AT);
    expect(written).toEqual([expect.objectContaining({ kind: 'platform-request', unit: 'fleet', at: AT })]);
  });
});

describe('drainTarget (#1840)', () => {
  const ZERO = { drained: 0, done: 0, failed: 0, pending: 0 };

  it('a vertical scope with no reachable deployment is unreachable — not zeros', async () => {
    const out = await drainTarget({ vertical: 'acme' }, async () => undefined);
    expect(out).toEqual({ report: { ...ZERO, unreachable: true } });
  });

  it('a scope with no vertical holds no intents: plain zeros, and nothing is resolved', async () => {
    let resolved = 0;
    const out = await drainTarget({ vertical: null }, async () => {
      resolved += 1;
      return 'client';
    });
    expect(out).toEqual({ report: ZERO });
    expect(resolved).toBe(0);
  });

  it('a reachable one hands back the client to drain through — the twin', async () => {
    const rec = { vertical: 'acme' };
    expect(await drainTarget(rec, async () => 'client')).toEqual({ rec, vertical: 'acme', client: 'client' });
  });
});

describe('timedDrain (#1840)', () => {
  const PASS_START = new Date('2026-09-27T12:00:00.000Z');
  const ticks = (...iso: string[]) => {
    const q = iso.map((t) => new Date(t));
    return () => q.shift()!;
  };

  it('finishes when the LAST drain settles — a late one, and a thrown one, both count', async () => {
    const timed = timedDrain(
      async (fail: boolean) => {
        if (fail) throw new Error('vertical down');
        return 'ok';
      },
      ticks('2026-09-27T12:00:05.000Z', '2026-09-27T12:00:09.000Z'),
    );
    await timed.drain(false);
    await expect(timed.drain(true)).rejects.toThrow('vertical down'); // still rethrown
    expect(timed.finishedAt(PASS_START).toISOString()).toBe('2026-09-27T12:00:09.000Z');
  });

  it('keeps the latest settle when an earlier-stamped one lands last', async () => {
    const timed = timedDrain(async () => 'ok', ticks('2026-09-27T12:00:09.000Z', '2026-09-27T12:00:05.000Z'));
    await timed.drain();
    await timed.drain();
    expect(timed.finishedAt(PASS_START).toISOString()).toBe('2026-09-27T12:00:09.000Z');
  });

  it('falls back to the pass start when no drain ran', () => {
    expect(timedDrain(async () => 'ok').finishedAt(PASS_START)).toBe(PASS_START);
  });
});
