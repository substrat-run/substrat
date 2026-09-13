import { describe, expect, it } from 'vitest';
import { instant, type OpsFailureEntry, type SweepRunEntry } from '@substrat-run/contracts';
import { deriveFleetHealth, followUpUnsweptApps, resolveSweepable, type FleetApp } from '../src/fleet-health.js';

const A = 'scope-a';
const B = 'scope-b';
const C = 'scope-c';
const D = 'scope-d';

const app = (scopeId: string, over: Partial<FleetApp> = {}): FleetApp =>
  ({ scopeId, name: `App ${scopeId.slice(-1).toUpperCase()}`, vertical: 'manyfold', ...over });
const sweep = (scopeId: string, over: Partial<SweepRunEntry> = {}): SweepRunEntry =>
  ({ scopeId, kind: 'schedule', outcome: 'ok', at: instant.parse('2026-09-10T10:00:00.000Z'), ...over }) as SweepRunEntry;
const failure = (scopeId: string): OpsFailureEntry => ({ scopeId }) as OpsFailureEntry;

describe('deriveFleetHealth (#1238)', () => {
  it('ranks worst first — the ordering IS the feature', () => {
    const rows = deriveFleetHealth({
      apps: [app(C), app(A), app(B), app(D)],
      failures: [failure(A)],
      sweeps: [
        sweep(A),
        sweep(B, { kind: 'freshness', outcome: 'failed' }),
        sweep(C),
        // D has no sweep rows at all.
      ],
    });
    expect(rows.map((r) => r.scopeId)).toEqual([A, B, D, C]);
    expect(rows.map((r) => r.state)).toEqual(['failing', 'stale', 'silent', 'ok']);
  });

  it('names the app, not only its scope — the row is the answer, not a lookup key', () => {
    // A firm running one vertical for thirty clients reads this panel to find out
    // WHOSE app is broken; a bare scope id makes them open every row to find out.
    const [row] = deriveFleetHealth({
      apps: [app(A, { name: 'Northside Clinic', vertical: 'meridian' })],
      failures: [failure(A)],
      sweeps: [],
    });
    expect(row!.name).toBe('Northside Clinic');
    expect(row!.vertical).toBe('meridian');
  });

  it('calls an unswept app SILENT, never ok', () => {
    // The distinction the whole initiative turns on: nothing has checked this app,
    // which is not the same as nothing being wrong with it. Rendering silence as
    // success is the failure mode every view here is built to refuse.
    const [row] = deriveFleetHealth({ apps: [app(A)], failures: [], sweeps: [] });
    expect(row!.state).toBe('silent');
    expect(row!.reason).toMatch(/nothing is checking it/);
    expect(row!.lastSweepAt).toBeNull();
  });

  it('a failed sweep is failing even with no ops failures, and says which', () => {
    const [row] = deriveFleetHealth({
      apps: [app(A)],
      failures: [],
      sweeps: [sweep(A, { outcome: 'failed' })],
    });
    expect(row!.state).toBe('failing');
    expect(row!.sweepFailures).toBe(1);
    expect(row!.reason).toBe('1 failed sweep recorded.');
  });

  it('counts both sources in one sentence when both are present', () => {
    const [row] = deriveFleetHealth({
      apps: [app(A)],
      failures: [failure(A), failure(A)],
      sweeps: [sweep(A, { outcome: 'failed' })],
    });
    expect(row!.reason).toBe('2 failures and 1 failed sweep recorded.');
  });

  it('reports the newest sweep instant, whatever order the rows arrive in', () => {
    const [row] = deriveFleetHealth({
      apps: [app(A)],
      failures: [],
      sweeps: [
        sweep(A, { at: instant.parse('2026-09-10T08:00:00.000Z') }),
        sweep(A, { at: instant.parse('2026-09-10T12:00:00.000Z') }),
        sweep(A, { at: instant.parse('2026-09-10T09:00:00.000Z') }),
      ],
    });
    expect(row!.lastSweepAt).toBe('2026-09-10T12:00:00.000Z');
  });

  it('never attributes another app’s signals', () => {
    const rows = deriveFleetHealth({
      apps: [app(A), app(B)],
      failures: [failure(B)],
      sweeps: [sweep(A), sweep(B)],
    });
    expect(rows.find((r) => r.scopeId === A)!.state).toBe('ok');
    expect(rows.find((r) => r.scopeId === B)!.state).toBe('failing');
  });

  it('reads UNKNOWN, not ok, when the signals could not be read', () => {
    // An unavailable read must not render as a clean bill of health for every app.
    const rows = deriveFleetHealth({ apps: [app(A), app(B)], failures: [], sweeps: [], available: false });
    expect(rows.every((r) => r.state === 'unknown')).toBe(true);
    expect(rows[0]!.reason).toMatch(/unavailable/);
  });

  it('a truncated FAILURE read withholds ok — "nothing found" is not "nothing there"', () => {
    // The read stopped at its cap with older rows behind it, so an app with nothing
    // against it inside the window has not been cleared; `ok` is the one verdict that
    // cannot be walked back, and silence is exactly what must not produce it.
    const rows = deriveFleetHealth({
      apps: [app(A), app(B)],
      failures: [failure(B)],
      sweeps: [sweep(A), sweep(B)],
      coverage: { failures: false, sweeps: true },
    });
    expect(rows.find((r) => r.scopeId === A)!.state).toBe('unknown');
    expect(rows.find((r) => r.scopeId === A)!.reason).toMatch(/could not be confirmed/);
    // A found failure is a FACT — an incomplete read can hide one, never invent one.
    expect(rows.find((r) => r.scopeId === B)!.state).toBe('failing');
  });

  it('a truncated SWEEP read costs the silent verdict, and only that one', () => {
    // The broad sweep read is the one that truncates first on a busy fleet, so it must
    // not take the failure answers with it: A is absent from it (silent → unknown),
    // while B's failure and C's staleness — which come from their own narrow reads —
    // still stand.
    const rows = deriveFleetHealth({
      apps: [app(A), app(B), app(C), app(D)],
      failures: [failure(B)],
      sweeps: [sweep(C, { kind: 'freshness', outcome: 'failed' }), sweep(D)],
      coverage: { failures: true, sweeps: false },
    });
    const by = (id: string) => rows.find((r) => r.scopeId === id)!;
    expect(by(A).state).toBe('unknown');
    expect(by(A).reason).toMatch(/whether anything is checking this app/);
    expect(by(B).state).toBe('failing');
    expect(by(C).state).toBe('stale');
    // An app the read DID reach is still answered normally.
    expect(by(D).state).toBe('ok');
  });

  it('an app that declares nothing to sweep is ok, not silent — its silence is by design', () => {
    // The sweeper writes a per-scope row only for a declared schedule or freshness
    // expectation. An app declaring neither is never swept and never will be, so a
    // "needs attention" row for it is one nobody can act on — which is how a panel
    // teaches its reader to skip it.
    const [row] = deriveFleetHealth({ apps: [app(A, { sweepable: false })], failures: [], sweeps: [] });
    expect(row!.state).toBe('ok');
    expect(row!.reason).toMatch(/Declares nothing to sweep/);
    // ...whatever the sweep read's coverage, since there is no row to have missed.
    const [truncated] = deriveFleetHealth({
      apps: [app(A, { sweepable: false })],
      failures: [],
      sweeps: [],
      coverage: { failures: true, sweeps: false },
    });
    expect(truncated!.state).toBe('ok');
  });

  it('a declared-but-unswept app is silent, and the reason names the declaration', () => {
    const [row] = deriveFleetHealth({ apps: [app(A, { sweepable: true })], failures: [], sweeps: [] });
    expect(row!.state).toBe('silent');
    expect(row!.reason).toMatch(/^Declares schedules or freshness expectations/);
  });

  it('a found failure still outranks "nothing to sweep"', () => {
    const [row] = deriveFleetHealth({ apps: [app(A, { sweepable: false })], failures: [failure(A)], sweeps: [] });
    expect(row!.state).toBe('failing');
  });

  it('a narrowed follow-up confirms an app the truncated broad read missed', () => {
    // A is absent from the truncated read but a follow-up reached the end of ITS
    // window with nothing: silent, not unknown. B was never followed up: unknown.
    const rows = deriveFleetHealth({
      apps: [app(A), app(B)],
      failures: [],
      sweeps: [],
      coverage: { failures: true, sweeps: false, sweepsConfirmed: new Set([A]) },
    });
    const by = (id: string) => rows.find((r) => r.scopeId === id)!;
    expect(by(A).state).toBe('silent');
    expect(by(B).state).toBe('unknown');
  });
});

describe('followUpUnsweptApps', () => {
  it('reads once per app the broad read missed, skipping the ones it reached or that declare nothing', async () => {
    const asked: string[] = [];
    const out = await followUpUnsweptApps({
      apps: [app(A), app(B), app(C, { sweepable: false }), app(D)],
      seen: new Set([B]),
      read: async (scopeId) => {
        asked.push(scopeId);
        return scopeId === A ? { entries: [sweep(A)], failed: false } : { entries: [], failed: false };
      },
    });
    expect(asked.sort()).toEqual([A, D]);
    expect([...out.confirmed].sort()).toEqual([A, D]);
    expect(out.sweeps.map((s) => s.scopeId)).toEqual([A]);
  });

  it('a follow-up that fails leaves its app unconfirmed', async () => {
    const out = await followUpUnsweptApps({
      apps: [app(A), app(B)],
      seen: new Set(),
      read: async (scopeId) => ({ entries: [], failed: scopeId === A }),
    });
    expect([...out.confirmed]).toEqual([B]);
  });

  it('is bounded by max, not by the record', async () => {
    let n = 0;
    const out = await followUpUnsweptApps({
      apps: [app(A), app(B), app(C)],
      seen: new Set(),
      read: async () => ({ entries: [], failed: false }) as never,
      max: 2,
    });
    n = out.confirmed.size;
    expect(n).toBe(2);
  });
});

describe('resolveSweepable', () => {
  // A stub plane: two verticals, one of which pins a scope to an older version.
  const cp = {
    listScopes: async (vertical: string) =>
      vertical === 'manyfold'
        ? [
            { id: A, verticalVersionId: 'v-old' },
            { id: B, verticalVersionId: null },
          ]
        : [{ id: C, verticalVersionId: null }],
    listChannels: async (vertical: string) =>
      vertical === 'manyfold' ? [{ channel: 'prod', versionId: 'v-new' }] : [{ channel: 'prod', versionId: 'auth-1' }],
    versionSchedules: async (_slug: string, versionId: string) =>
      versionId === 'v-new'
        ? { schedules: [{ operation: 'x', cadence: { everyMinutes: 5 }, permissions: [] }], freshness: null }
        : { schedules: null, freshness: null },
  } as unknown as Parameters<typeof resolveSweepable>[0];

  it('resolves the running version per app — its own binding, else the prod head', async () => {
    const out = await resolveSweepable(cp, [app(A), app(B), app(C, { vertical: 'auth-server' })]);
    // A is pinned to v-old, which declares nothing; B runs the prod head, which does.
    expect(out.get(A)).toBe(false);
    expect(out.get(B)).toBe(true);
    expect(out.get(C)).toBe(false);
  });

  it('reads per distinct vertical and version, never per app', async () => {
    const calls = { scopes: 0, channels: 0, versions: 0 };
    const counting = {
      listScopes: async (v: string) => (calls.scopes++, cp.listScopes(v)),
      listChannels: async (v: string) => (calls.channels++, cp.listChannels(v)),
      versionSchedules: async (s: string, v: string) => (calls.versions++, cp.versionSchedules(s, v)),
    } as unknown as Parameters<typeof resolveSweepable>[0];
    // Thirty clients on one vertical, all on the prod head.
    const many = Array.from({ length: 30 }, (_, i) => app(`scope-${i}`));
    await resolveSweepable(counting, many);
    expect(calls).toEqual({ scopes: 1, channels: 1, versions: 1 });
  });

  it('answers null, not false, when the running version cannot be named', async () => {
    const broken = {
      ...cp,
      listChannels: async () => {
        throw new Error('plane away');
      },
    } as unknown as Parameters<typeof resolveSweepable>[0];
    const out = await resolveSweepable(broken, [app(B)]);
    expect(out.get(B)).toBeNull();
  });

  it('answers null, not false, when the declaration read itself failed', async () => {
    // `versionSchedules` hands back the same two nulls for a non-200 as for a
    // pre-field push; only the second is an absence. A transient fault answered
    // `false` would turn an unswept app into an `ok` "nothing to sweep".
    const flaky = {
      ...cp,
      versionSchedules: async () => ({ schedules: null, freshness: null, failed: true }),
    } as unknown as Parameters<typeof resolveSweepable>[0];
    const out = await resolveSweepable(flaky, [app(A), app(B)]);
    expect(out.get(A)).toBeNull();
    expect(out.get(B)).toBeNull();
  });
});
