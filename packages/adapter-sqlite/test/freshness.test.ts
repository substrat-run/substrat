import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { instant, moduleId, platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { contractTestBareOps, scheduleMod } from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';

/**
 * The freshness evaluator (#1232), on the one adapter whose clock is scriptable —
 * which is the only way to reach the STALE verdict without waiting an hour. The
 * shared suites cover ok / never-seen / change-gating; this file owns time.
 */
describe('checkFreshness — the stale verdict, the heartbeat, and the collapse', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let nowIso = '2026-09-07T10:00:00.000Z';
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const SCHED = moduleId.parse('@test/sched');

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-freshness-'));
    // The DEFAULT checker: provisioning projects the schedule's system grant
    // (#383), so the tick fires through the same door the real sweep uses.
    host = new SqliteScopeHost({ dir, clock: () => instant.parse(nowIso) });
    for (const [name, handler] of Object.entries(contractTestBareOps)) {
      host.defineOperation(name, handler);
    }
    host.registerModule(scheduleMod);
    await host.admin.createTenant(staff, { id: t, slug: 'fresh-tenant', name: 'Fresh' });
    await host.admin.grantEntitlement(staff, t, 'sched');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'fresh-vertical' });
    await host.admin.activateScope(staff, t, s);
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('never-seen → skipped; an arrived event → ok (a CHANGE, reported); unchanged inside the heartbeat → silence', async () => {
    // No sched.ticked has ever landed: the never-run analogue, not a failure.
    const first = await host.checkFreshness(SCHED, t, s);
    expect(first.checks).toEqual([
      { eventType: 'sched.ticked', outcome: 'skipped', observedAt: null, withinHours: 1 },
    ]);

    // The event arrives — fired through the sweep door itself.
    const run = await host.runDueSchedules(SCHED, t, s);
    expect(run.fired).toBe(1);
    const second = await host.checkFreshness(SCHED, t, s);
    expect(second.checks).toHaveLength(1);
    expect(second.checks[0]).toMatchObject({ eventType: 'sched.ticked', outcome: 'ok' });
    expect(second.checks[0]!.observedAt).toBe(nowIso);
    // The duplicate declaration collapsed to the TIGHTEST window (1h, not 24h) —
    // one check per (scope, eventType), or the drain dedupe would eat a row.
    expect(second.checks[0]!.withinHours).toBe(1);

    // Same verdict, minutes later: change-gated, heartbeat not due — nothing.
    nowIso = '2026-09-07T10:30:00.000Z';
    expect((await host.checkFreshness(SCHED, t, s)).checks).toEqual([]);
  });

  it('the heartbeat re-reports an unchanged verdict hourly — "no rows" stays unambiguous', async () => {
    nowIso = '2026-09-07T10:59:00.000Z'; // still fresh (59m < 1h window), heartbeat about to lapse
    expect((await host.checkFreshness(SCHED, t, s)).checks).toEqual([]);
    nowIso = '2026-09-07T11:05:00.000Z'; // >60m since the last recorded row at 10:00
    const beat = await host.checkFreshness(SCHED, t, s);
    expect(beat.checks).toHaveLength(1);
    // Stale now too (65m past the event on a 1h window) — the heartbeat and the
    // change coincide here, and the verdict is the honest one.
    expect(beat.checks[0]!.outcome).toBe('failed');
    expect(beat.checks[0]!.observedAt).toBe('2026-09-07T10:00:00.000Z');
  });

  it('a fresh event flips the verdict back — the strip shows the recovery, not just the outage', async () => {
    nowIso = '2026-09-07T12:10:00.000Z'; // past the 1h cadence, so the tick fires again
    expect((await host.runDueSchedules(SCHED, t, s)).fired).toBe(1);
    const back = await host.checkFreshness(SCHED, t, s);
    expect(back.checks).toHaveLength(1);
    expect(back.checks[0]).toMatchObject({ outcome: 'ok', observedAt: '2026-09-07T12:10:00.000Z' });
  });
});
