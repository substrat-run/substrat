import { describe, it, expect } from 'vitest';
import { platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import type { AdminLogEntry, OrphanSweepAudit, ScopeId, TenantId } from '@substrat-run/contracts';
import { runPlatformSweep, ORPHAN_SWEEP_DRY_RUN_WINDOW_MS } from '../src/platform-sweep.js';
import type { OrphanAttachmentOutcome, OrphanAttachmentSweepOptions, PlatformSweepOptions } from '../src/platform-sweep.js';
import type { OrphanSweepReport } from '../src/attachment-sweep.js';
import type { FetchLike, ScopeHost } from '../src/scope-host.js';

/**
 * The orphan-attachment phase (#2314), with fakes: which scopes it visits, what it asks of each,
 * what it counts, and when it writes the admin-log row a later delete needs. The reach itself (the
 * directory checks, the serving script) is held in control-plane-api; the pass in the kernel suite.
 */

const ACTOR = platformActorId.parse('01JZ00000000000000000000SW');
const FETCH = (() => Promise.reject(new Error('unused'))) as unknown as FetchLike;
const T = tenantId.parse('01J00000000000000000000T01');
const NOW = '2026-10-17T12:00:00.000Z';
const DAY = 86_400_000;

const sid = (n: number) => scopeId.parse('01J' + String(n).padStart(23, '0'));

interface FakeScope {
  id: ScopeId;
  tenantId: TenantId;
  status?: string;
  forkedFrom?: string | null;
  kind?: string;
}

function fakeHost(scopes: FakeScope[], log: AdminLogEntry[] = []) {
  let n = 0;
  const admin = {
    listScopes: async (_a: unknown, filter?: { status?: string | string[] }) => {
      const wanted = filter?.status === undefined ? null : ([] as string[]).concat(filter.status);
      return scopes
        .map((s) => ({ forkedFrom: null, kind: 'primary', status: 'active', ...s }))
        .filter((s) => wanted === null || wanted.includes(s.status));
    },
    listConnections: async () => [],
    auditLog: async (_a: unknown, f: { tenantId?: string; scopeId?: string; action?: string; since?: string }) =>
      log.filter(
        (r) =>
          (f.tenantId === undefined || r.tenantId === f.tenantId) &&
          (f.scopeId === undefined || r.scopeId === f.scopeId) &&
          (f.action === undefined || r.action === f.action) &&
          (f.since === undefined || r.at >= f.since),
      ),
    recordOrphanSweep: async (actor: string, entry: OrphanSweepAudit) => {
      const { tenantId: t, scopeId: s, ...after } = entry;
      log.push({ id: `row-${++n}`, actor, action: 'sweepOrphanAttachments', tenantId: t, scopeId: s, before: null, after, at: NOW } as unknown as AdminLogEntry);
    },
  };
  return { host: { admin } as unknown as ScopeHost, log };
}

const report = (over: Partial<OrphanSweepReport> = {}): OrphanSweepReport => ({
  listed: 0, candidates: 0, orphans: 0, deleted: 0, keys: [], dryRun: true, ...over,
});

/** Only the phase under test: every other phase is off or finds nothing. */
function opts(phase: Partial<OrphanAttachmentSweepOptions> & Pick<OrphanAttachmentSweepOptions, 'sweepScopeFn'>): PlatformSweepOptions {
  return {
    actor: ACTOR,
    fetch: FETCH,
    sweepers: {},
    drainRetries: false,
    gcSnapshots: false,
    reconcileMigrations: false,
    runSchedules: false,
    orphanAttachments: { mode: 'dry-run', now: () => NOW, rng: () => 0, ...phase },
  };
}

describe('runPlatformSweep · orphan attachments (#2314)', () => {
  it('is off by default: no option, no call and a null report', async () => {
    const { host } = fakeHost([{ id: sid(1), tenantId: T }]);
    const r = await runPlatformSweep(host, { actor: ACTOR, fetch: FETCH, sweepers: {}, drainRetries: false, gcSnapshots: false, reconcileMigrations: false, runSchedules: false });
    expect(r.orphanAttachments).toBeNull();
  });

  it('visits active primary scopes only, and asks each for a dry run in dry-run mode', async () => {
    const live = sid(1);
    const { host } = fakeHost([
      { id: live, tenantId: T },
      { id: sid(2), tenantId: T, forkedFrom: sid(1) },
      { id: sid(3), tenantId: T, kind: 'preview' },
      { id: sid(4), tenantId: T, status: 'archived' },
    ]);
    const calls: [string, boolean][] = [];
    const r = await runPlatformSweep(host, opts({
      sweepScopeFn: async (_t, s, o) => (calls.push([s, o.dryRun]), { swept: report() }),
    }));
    expect(calls).toEqual([[live, true]]);
    expect(r.orphanAttachments).toMatchObject({ mode: 'dry-run', eligible: 1, visited: 1, deferred: 0, dryRuns: 1, deletes: 0 });
  });

  it('writes the admin-log row when a pass found orphans, and none when it found nothing', async () => {
    const found = sid(1);
    const clean = sid(2);
    const { host, log } = fakeHost([{ id: found, tenantId: T }, { id: clean, tenantId: T }]);
    const keys = [`scope/${found}/att/01H00000000000000000000001`];
    const r = await runPlatformSweep(host, opts({
      sweepScopeFn: async (_t, s) => ({ swept: s === found ? report({ listed: 3, candidates: 2, orphans: 1, keys }) : report({ listed: 4 }) }),
    }));
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ action: 'sweepOrphanAttachments', tenantId: T, scopeId: found, actor: ACTOR, after: { dryRun: true, listed: 3, candidates: 2, orphans: 1, deleted: 0, keys } });
    expect(r.orphanAttachments).toMatchObject({ orphans: 1, deleted: 0 });
  });

  describe('delete mode needs a recent dry-run row for the scope', () => {
    const S = sid(7);
    const dryRow = (at: string, dryRun = true) =>
      ({ id: `old-${at}`, actor: ACTOR, action: 'sweepOrphanAttachments', tenantId: T, scopeId: S, before: null, after: { dryRun, orphans: 1 }, at }) as unknown as AdminLogEntry;

    it('gives a scope with no dry-run row a dry run, whose row then licenses the next pass to delete', async () => {
      const { host, log } = fakeHost([{ id: S, tenantId: T }]);
      const asked: boolean[] = [];
      const fn = async (_t: TenantId, _s: ScopeId, o: { dryRun: boolean }): Promise<OrphanAttachmentOutcome> => {
        asked.push(o.dryRun);
        return { swept: report({ dryRun: o.dryRun, orphans: 2, deleted: o.dryRun ? 0 : 2, keys: ['k1', 'k2'] }) };
      };
      const first = await runPlatformSweep(host, opts({ mode: 'delete', sweepScopeFn: fn }));
      expect(first.orphanAttachments).toMatchObject({ mode: 'delete', awaitingDryRun: 1, dryRuns: 1, deletes: 0, deleted: 0 });
      const second = await runPlatformSweep(host, opts({ mode: 'delete', sweepScopeFn: fn }));
      expect(asked).toEqual([true, false]);
      expect(second.orphanAttachments).toMatchObject({ awaitingDryRun: 0, dryRuns: 0, deletes: 1, deleted: 2 });
      expect(log.map((r) => (r.after as { dryRun: boolean }).dryRun)).toEqual([true, false]);
    });

    it('a dry-run row older than the window does not license a delete, and one inside it does', async () => {
      const just = new Date(Date.parse(NOW) - ORPHAN_SWEEP_DRY_RUN_WINDOW_MS + 1000).toISOString();
      const stale = new Date(Date.parse(NOW) - ORPHAN_SWEEP_DRY_RUN_WINDOW_MS - 1000).toISOString();
      for (const [at, expected] of [[stale, true], [just, false]] as const) {
        const { host } = fakeHost([{ id: S, tenantId: T }], [dryRow(at)]);
        const asked: boolean[] = [];
        await runPlatformSweep(host, opts({ mode: 'delete', sweepScopeFn: async (_t, _s, o) => (asked.push(o.dryRun), { swept: report({ dryRun: o.dryRun }) }) }));
        expect(asked).toEqual([expected]);
      }
    });

    it("a delete row is not a dry run, and another scope's dry run licenses nothing here", async () => {
      const recent = new Date(Date.parse(NOW) - DAY).toISOString();
      const other = { ...(dryRow(recent) as unknown as Record<string, unknown>), id: 'other', scopeId: sid(8) } as unknown as AdminLogEntry;
      const { host } = fakeHost([{ id: S, tenantId: T }], [dryRow(recent, false), other]);
      const asked: boolean[] = [];
      await runPlatformSweep(host, opts({ mode: 'delete', sweepScopeFn: async (_t, _s, o) => (asked.push(o.dryRun), { swept: report() }) }));
      expect(asked).toEqual([true]);
    });

    it('dry-run mode never asks for a delete, whatever the log holds', async () => {
      const { host } = fakeHost([{ id: S, tenantId: T }], [dryRow(new Date(Date.parse(NOW) - DAY).toISOString())]);
      const asked: boolean[] = [];
      await runPlatformSweep(host, opts({ mode: 'dry-run', sweepScopeFn: async (_t, _s, o) => (asked.push(o.dryRun), { swept: report() }) }));
      expect(asked).toEqual([true]);
    });
  });

  it('counts refusals, old deployments and missing stores apart, and none of them is an error', async () => {
    const [a, b, c, d] = [sid(1), sid(2), sid(3), sid(4)];
    const { host } = fakeHost([a, b, c, d].map((id) => ({ id, tenantId: T })));
    const outcomes = new Map<string, OrphanAttachmentOutcome>([
      [a, { refused: 'copy pending' }],
      [b, { unsupported: 'redeploy' }],
      [c, { swept: report({ bucket: 'none' }) }],
      [d, { swept: report({ listed: 0 }) }],
    ]);
    const r = await runPlatformSweep(host, opts({ sweepScopeFn: async (_t, s) => outcomes.get(s)! }));
    expect(r.errors).toEqual([]);
    expect(r.orphanAttachments).toMatchObject({
      refused: { count: 1, scopeIds: [a] },
      unsupported: { count: 1, scopeIds: [b] },
      noStore: { count: 1, scopeIds: [c] },
      dryRuns: 2,
    });
  });

  it('a throw is an attachment-sweep error, and the rest of the window carries on', async () => {
    const [a, b] = [sid(1), sid(2)];
    const { host } = fakeHost([{ id: a, tenantId: T }, { id: b, tenantId: T }]);
    const r = await runPlatformSweep(host, opts({
      sweepScopeFn: async (_t, s) => {
        if (s === a) throw new Error('transport');
        return { swept: report({ orphans: 1, keys: ['k'] }) };
      },
    }));
    expect(r.errors).toEqual([{ kind: 'attachment-sweep', id: a, error: 'transport' }]);
    expect(r.orphanAttachments).toMatchObject({ dryRuns: 1, orphans: 1 });
  });

  it("reports the deployment's word on what it did, not the mode it was asked for", async () => {
    const { host } = fakeHost([{ id: sid(1), tenantId: T }]);
    const r = await runPlatformSweep(host, opts({ sweepScopeFn: async () => ({ swept: report({ dryRun: false, deleted: 1, keys: ['k'] }) }) }));
    expect(r.orphanAttachments).toMatchObject({ dryRuns: 0, deletes: 1, deleted: 1 });
  });

  it('a fenced pass is counted', async () => {
    const { host } = fakeHost([{ id: sid(1), tenantId: T }]);
    const r = await runPlatformSweep(host, opts({ sweepScopeFn: async () => ({ swept: report({ fencedUntil: NOW }) }) }));
    expect(r.orphanAttachments?.fenced).toBe(1);
  });

  describe('the window', () => {
    const ids = [1, 2, 3, 4, 5, 6, 7].map(sid);
    const scopes = ids.map((id) => ({ id, tenantId: T }));

    it('takes at most `batch`, wrapping past the end of the id order', async () => {
      const { host } = fakeHost([...scopes].reverse());
      const seen: string[] = [];
      const r = await runPlatformSweep(host, {
        ...opts({ batch: 3, rng: () => 5.5 / 7, sweepScopeFn: async (_t, s) => (seen.push(s), { swept: report() }) }),
        concurrency: 1,
      });
      expect(seen).toEqual([ids[5], ids[6], ids[0]]);
      expect(r.orphanAttachments).toMatchObject({ eligible: 7, visited: 3, deferred: 4 });
    });

    it('reaches every scope over enough passes', async () => {
      const { host } = fakeHost(scopes);
      const seen = new Set<string>();
      let pass = 0;
      for (; pass < 3; pass++) {
        const start = (pass * 3 + 0.5) / 7;
        await runPlatformSweep(host, opts({ batch: 3, rng: () => start, sweepScopeFn: async (_t, s) => (seen.add(s), { swept: report() }) }));
      }
      expect([...seen].sort()).toEqual([...ids].sort());
    });

    it('`0` pauses: nothing is visited, and every scope is deferred', async () => {
      const { host } = fakeHost(scopes);
      let called = 0;
      const r = await runPlatformSweep(host, opts({ batch: 0, sweepScopeFn: async () => (called++, { swept: report() }) }));
      expect(called).toBe(0);
      expect(r.orphanAttachments).toMatchObject({ visited: 0, deferred: 7 });
    });
  });

  it('refuses a garbled batch or mode before any phase runs', async () => {
    const { host } = fakeHost([{ id: sid(1), tenantId: T }]);
    const fn = async () => ({ swept: report() });
    await expect(runPlatformSweep(host, opts({ batch: 1.5, sweepScopeFn: fn }))).rejects.toThrow(/orphanAttachments.batch/);
    await expect(runPlatformSweep(host, opts({ mode: 'yes' as never, sweepScopeFn: fn }))).rejects.toThrow(/orphanAttachments.mode/);
  });
});
