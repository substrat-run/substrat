import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformActorId, scopeId, tenantId, type ScopeId } from '@substrat-run/contracts';
import { runPlatformSweep, ulid, type FetchLike, type HostAdmin, type ScopeHost } from '@substrat-run/kernel';
import type { DirectoryExec } from './findings-atomic-suite.js';
import type { ScopeHostFixture } from './scope-host-suite.js';

const FETCH: FetchLike = async () => new Response(null, { status: 599 });

/**
 * One directory row that does not read as a scope must not stop a fleet-wide pass. The strict
 * `listScopes` is unchanged and still refuses the list; `listScopesReadable` answers the rest of
 * it and names the row, and `runPlatformSweep` reads through it, so every phase after the first
 * still runs and the row is named once.
 *
 * The pass is narrowed to this suite's own scopes: an adapter's directory may hold other suites'
 * scopes, and a whole-fleet pass over them would reap and drain things this suite does not own.
 * Every planted row is written back before the suite ends, for the same reason. `exec` writes
 * the directory past the provisioning boundary, which is how such a row is reached at all (one
 * stored before the refusal, or a restore).
 */
export function unreadableScopeRowContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture>,
  exec: DirectoryExec,
): void {
  describe(`an unreadable scope row in a fleet-wide pass: ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    const mine = new Set<string>();
    let live: ScopeId;
    let preview: ScopeId;
    let archived: ScopeId;
    let blank: ScopeId;
    let second: ScopeId;

    /** The stored `vertical` of one row, written as given. Both values are literals of this suite. */
    const writeVertical = (scope: ScopeId, vertical: 'todo' | '') =>
      exec(host, `UPDATE scopes SET vertical = '${vertical}' WHERE scope_id = '${scope}'`);

    const provision = async (extra: Record<string, unknown> = {}): Promise<ScopeId> => {
      const s = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'todo', ...extra });
      await host.admin.activateScope(staff, t, s);
      mine.add(s);
      return s;
    };

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      await host.admin.createTenant(staff, { id: t, slug: `unreadable-${t.slice(-10).toLowerCase()}`, name: 'Unreadable' });
      live = await provision();
      preview = await provision({ kind: 'preview', expiresAt: '2000-01-01T00:00:00.000Z' });
      archived = await provision();
      await host.admin.archiveScope(staff, t, archived);
      blank = await provision();
      second = await provision();
    });

    afterAll(async () => {
      await writeVertical(blank, 'todo');
      await writeVertical(second, 'todo');
      await fixture.cleanup();
    });

    it('answers a healthy directory exactly as listScopes does', async () => {
      const strict = await host.admin.listScopes(staff, { tenantId: t });
      const readable = await host.admin.listScopesReadable!(staff, { tenantId: t });
      expect(readable).toEqual({ scopes: strict, unreadable: [] });
    });

    describe('with two rows that do not read as scopes', () => {
      beforeAll(async () => {
        // The stored shape provisioning used to accept, which the `scope` schema reads back as a
        // parse error. Two of them, so "named once" is about phases and not about there being one.
        await writeVertical(blank, '');
        await writeVertical(second, '');
      });

      it('leaves listScopes strict', async () => {
        await expect(host.admin.listScopes(staff, { tenantId: t })).rejects.toThrow();
      });

      it('names each by its ids and failed field in listScopesReadable, and answers the rest', async () => {
        const { scopes, unreadable } = await host.admin.listScopesReadable!(staff, { tenantId: t });
        expect(scopes.map((s) => s.id).sort()).toEqual([live, preview, archived].sort());
        expect(unreadable.sort((a, b) => a.scopeId.localeCompare(b.scopeId))).toEqual(
          [blank, second].sort().map((s) => ({ scopeId: s, tenantId: t, fields: ['vertical'] })),
        );
      });

      it('runs every later phase of a pass and names each row once', async () => {
        const drained: string[] = [];
        const platformDrained: string[] = [];
        const gc: string[] = [];
        const reaped: string[] = [];
        const shipped: string[] = [];
        const report = await runPlatformSweep(narrowedTo(host, mine, drained), {
          actor: staff,
          fetch: FETCH,
          sweepers: {},
          runSchedules: false,
          drainPlatformRequestsFn: async (_t, s) => (platformDrained.push(s), { drained: 0, done: 0, failed: 0, pending: 0, attempted: [] }),
          reconcileScopeFn: async () => {},
          deleteSnapshotFn: async (_t, s) => void gc.push(s),
          reapArchivedAfterDays: 0,
          reapScopeFn: async (_t, s) => void reaped.push(s),
          eventSink: { ship: async (scope) => (shipped.push(scope.scopeId), { ref: 'r' }) },
        });
        // The migration phase reads first; every phase below it ran.
        expect(report.migrations).not.toBeNull();
        expect(drained.sort()).toEqual([live, preview].sort());
        expect(platformDrained.sort()).toEqual([live, preview].sort());
        expect(report.provisionReconcile).not.toBeNull();
        expect(gc).toEqual([preview]);
        expect(reaped).toEqual([archived]);
        expect(report.eventDrain).not.toBeNull();
        // Each row once, however many phases met it, by id and field and nothing of the row.
        const rows = report.errors.filter((e) => e.kind === 'scope-row');
        expect(rows.map((e) => e.id).sort()).toEqual([blank, second].sort());
        for (const e of rows) expect(e.error).toMatch(new RegExp(`tenant ${t} .*\\(vertical\\)`));
        expect(report.errors.filter((e) => e.kind !== 'scope-row')).toEqual([]);
      });
    });
  });
}

/**
 * The host as a pass sees it, narrowed to `mine`: both directory reads answer only these scopes,
 * no connection is listed, and `drainDue` records the scope instead of waking it.
 */
function narrowedTo(host: ScopeHost, mine: ReadonlySet<string>, drained: string[]): ScopeHost {
  const admin = new Proxy(host.admin, {
    get(target, p) {
      if (p === 'listScopes') {
        return async (...args: Parameters<HostAdmin['listScopes']>) => (await target.listScopes(...args)).filter((s) => mine.has(s.id));
      }
      if (p === 'listScopesReadable') {
        return async (...args: Parameters<HostAdmin['listScopes']>) => {
          const l = await target.listScopesReadable!(...args);
          return { scopes: l.scopes.filter((s) => mine.has(s.id)), unreadable: l.unreadable.filter((u) => mine.has(u.scopeId)) };
        };
      }
      if (p === 'listConnections') return async () => [];
      return forward(target, p);
    },
  });
  return new Proxy(host, {
    get(target, p) {
      if (p === 'admin') return admin;
      if (p === 'drainDue') {
        return async (_t: string, s: string) => (drained.push(s), { attempted: 0, delivered: 0, retrying: 0, deadLettered: 0 });
      }
      return forward(target, p);
    },
  });
}

/** Everything a narrowed view does not answer itself, from the object it wraps. */
function forward(target: object, p: string | symbol): unknown {
  const v = Reflect.get(target, p) as unknown;
  return typeof v === 'function' ? v.bind(target) : v;
}
