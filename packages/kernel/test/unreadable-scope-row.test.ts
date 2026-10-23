import { describe, expect, it } from 'vitest';
import { platformActorId, scope as scopeSchema, type Scope } from '@substrat-run/contracts';
import { readableScopes } from '../src/scope-record.js';
import { runCrossVerticalFrom, runPlatformSweep } from '../src/platform-sweep.js';
import { ulid } from '../src/ulid.js';
import type { ScopeHost, ScopeListing } from '../src/scope-host.js';

const ACTOR = platformActorId.parse(ulid());
const FETCH = async () => new Response(null, { status: 599 });
const T = ulid();

/** A directory row as an adapter reads it: the columns `readableScopes` names a bad one by. */
type Row = { scope_id: string; tenant_id: string; vertical: string | null };

const scopeOf = (r: Row): Scope =>
  scopeSchema.parse({
    id: r.scope_id,
    tenantId: r.tenant_id,
    parentScopeId: null,
    slug: r.scope_id.toLowerCase(),
    kind: 'scope',
    name: 'n',
    status: 'active',
    storageShape: 'A',
    jurisdiction: 'global',
    vertical: r.vertical,
    schemaVersion: '0',
    verticalVersionId: null,
    provisionedVersionId: null,
    retirementsFinishedVersionId: null,
    boundShapes: null,
    migrationFailure: null,
    forkedFrom: null,
    forkedAt: null,
    expiresAt: null,
    archivedAt: null,
    archivedFromStatus: null,
    createdAt: new Date().toISOString(),
  });

const row = (vertical: string | null): Row => ({ scope_id: ulid(), tenant_id: T, vertical });

describe('readableScopes', () => {
  it('answers every row of a healthy directory, in order, with nothing unreadable', () => {
    const rows = [row('todo'), row(null), row('acme/todo')];
    const listing = readableScopes(rows, scopeOf);
    expect(listing.scopes.map((s) => s.id)).toEqual(rows.map((r) => r.scope_id));
    expect(listing.unreadable).toEqual([]);
  });

  it('names a row that does not parse by its ids and failed field, and keeps the rest', () => {
    const bad = row('');
    const rows = [row('todo'), bad, row('ticket0')];
    const listing = readableScopes(rows, scopeOf);
    expect(listing.scopes.map((s) => s.id)).toEqual([rows[0]!.scope_id, rows[2]!.scope_id]);
    expect(listing.unreadable).toEqual([{ scopeId: bad.scope_id, tenantId: T, fields: ['vertical'] }]);
  });

  it('carries no value the row held, only field names', () => {
    const bad = row('todo');
    const listing = readableScopes([bad], (r) => scopeSchema.parse({ ...scopeOf(r), status: 'SECRET-LOOKING VALUE', name: '' }));
    expect(JSON.stringify(listing)).not.toMatch(/SECRET/);
    expect(listing.unreadable[0]!.fields.sort()).toEqual(['name', 'status']);
  });

  it("names a failure that is not a parse as the 'row'", () => {
    const bad = row('todo');
    const listing = readableScopes([bad], () => {
      throw new Error('bound_shapes is not JSON: {"value": "x"}');
    });
    expect(listing.unreadable).toEqual([{ scopeId: bad.scope_id, tenantId: T, fields: ['row'] }]);
  });

  it('bounds a stored id it repeats', () => {
    const listing = readableScopes([{ scope_id: 'x'.repeat(500), tenant_id: T, vertical: '' }], scopeOf);
    expect(listing.unreadable[0]!.scopeId).toHaveLength(64);
  });
});

/**
 * A host whose directory holds `good` scopes and `bad` rows that do not read as scopes: its
 * strict `listScopes` throws, as both adapters' does, and `listScopesReadable` steps over them.
 */
function hostWith(good: Scope[], bad: Row[], opts: { readable?: boolean } = {}) {
  const reads = { strict: 0, readable: 0 };
  const listing = (): ScopeListing => readableScopes([...good.map((s) => ({ scope_id: s.id, tenant_id: s.tenantId, vertical: s.vertical })), ...bad], scopeOf);
  const admin = {
    listScopes: async () => {
      reads.strict += 1;
      const l = listing();
      if (l.unreadable.length > 0) throw new Error('a directory row does not parse');
      return l.scopes;
    },
    ...(opts.readable === false
      ? {}
      : {
          listScopesReadable: async () => {
            reads.readable += 1;
            return listing();
          },
        }),
    listConnections: async () => [],
  };
  const drained: string[] = [];
  const host = {
    admin,
    drainDue: async (_t: string, s: string) => {
      drained.push(s);
      return { attempted: 0, delivered: 0, retrying: 0, deadLettered: 0 };
    },
  } as unknown as ScopeHost;
  return { host, reads, drained };
}

describe('runPlatformSweep over a directory with an unreadable row', () => {
  const good = [scopeOf(row('todo')), scopeOf(row(null))];

  it('runs every phase that reads the directory, and names the row once', async () => {
    const bad = row('');
    const { host, reads, drained } = hostWith(good, [bad]);
    const platformDrained: string[] = [];
    const report = await runPlatformSweep(host, {
      actor: ACTOR,
      fetch: FETCH,
      sweepers: {},
      drainPlatformRequestsFn: async (_t, s) => (platformDrained.push(s), { drained: 0, done: 0, failed: 0, pending: 0, attempted: [] }),
      reconcileScopeFn: async () => {},
      deleteSnapshotFn: async () => {},
      reapArchivedAfterDays: 0,
      reapScopeFn: async () => {},
    });
    // Each phase after the first read the directory and went on with the readable scopes.
    expect(drained.sort()).toEqual(good.map((s) => s.id).sort());
    expect(platformDrained.sort()).toEqual(good.map((s) => s.id).sort());
    expect(report.provisionReconcile).not.toBeNull();
    expect(reads.readable).toBeGreaterThan(3);
    expect(reads.strict).toBe(0);
    // Named once for the whole pass, by id and field, however many phases met it.
    expect(report.errors).toEqual([
      { kind: 'scope-row', id: bad.scope_id, error: expect.stringMatching(new RegExp(`tenant ${T} .*\\(vertical\\)`)) },
    ]);
  });

  it('names at most twenty rows a pass, then says there are more', async () => {
    const bad = Array.from({ length: 25 }, () => row(''));
    const { host } = hostWith(good, bad);
    const report = await runPlatformSweep(host, { actor: ACTOR, fetch: FETCH, sweepers: {}, drainPlatformRequestsFn: async () => ({ drained: 0, done: 0, failed: 0, pending: 0, attempted: [] }) });
    const rows = report.errors.filter((e) => e.kind === 'scope-row');
    expect(rows).toHaveLength(21);
    expect(rows.slice(0, 20).map((e) => e.id)).toEqual(bad.slice(0, 20).map((r) => r.scope_id));
    expect(rows[20]).toMatchObject({ id: '*', error: expect.stringMatching(/more than 20/) });
  });

  it('reports nothing over a healthy directory', async () => {
    const { host, drained } = hostWith(good, []);
    const report = await runPlatformSweep(host, { actor: ACTOR, fetch: FETCH, sweepers: {} });
    expect(report.errors).toEqual([]);
    expect(drained.sort()).toEqual(good.map((s) => s.id).sort());
  });

  describe('the tenant reap reads its tenant strictly', () => {
    /** One tenant past its grace window, whose scopes are `good` plus `bad`. */
    const reapPass = async (bad: Row[]) => {
      const { host } = hostWith(good, bad);
      const cleared: string[] = [];
      const reapedScopes: string[] = [];
      Object.assign(host.admin, {
        listTenants: async () => [{ id: T, status: 'deleting', deletingAt: '2000-01-01T00:00:00.000Z' }],
        archiveScope: async () => {},
        reapTenant: async (_a: unknown, t: string) => void cleared.push(t),
      });
      const report = await runPlatformSweep(host, {
        actor: ACTOR,
        fetch: FETCH,
        sweepers: {},
        reapDeletingAfterDays: 0,
        reapScopeFn: async (_t, s) => void reapedScopes.push(s),
      });
      return { report, cleared, reapedScopes };
    };

    it("leaves a tenant's directory in place while one of its rows does not read", async () => {
      const bad = row('');
      const { report, cleared } = await reapPass([bad]);
      // Stepping over the row would clear the directory that finds a scope never reaped.
      expect(cleared).toEqual([]);
      expect(report.errors).toContainEqual({ kind: 'reap-tenant', id: T, error: expect.any(String) });
    });

    it('reaps every scope of a tenant whose rows all read, then clears its directory', async () => {
      const { report, cleared, reapedScopes } = await reapPass([]);
      expect(reapedScopes.sort()).toEqual(good.map((s) => s.id).sort());
      expect(cleared).toEqual([T]);
      expect(report.tenantsReaped).toBe(1);
    });
  });

  it("runs a producer's cross-vertical edges beside the row, naming it once (the router kick)", async () => {
    const bad = row('');
    const { host, reads } = hostWith(good, [bad]);
    const out = await runCrossVerticalFrom(
      host,
      { actor: ACTOR, crossVertical: {} },
      { tenantId: good[0]!.tenantId, scopeId: good[0]!.id },
    );
    expect(reads.strict).toBe(0);
    expect(out.errors).toEqual([{ kind: 'scope-row', id: bad.scope_id, error: expect.stringMatching(/\(vertical\)/) }]);
  });

  it('samples resting scopes for the storage gauge beside the row', async () => {
    const bad = row('');
    const { host, reads } = hostWith(good, [bad]);
    Object.assign(host.admin, {
      listScopeStorageAttempts: async () => [],
      recordScopeStorage: async (_a: unknown, readings: unknown[]) => ({ recorded: readings.length }),
      pruneScopeStorage: async () => 0,
    });
    const report = await runPlatformSweep(host, {
      actor: ACTOR,
      fetch: FETCH,
      sweepers: {},
      storageGauge: { read: async () => 4096 },
    });
    // The gauge's own directory read stepped over the row instead of failing the phase.
    expect(report.errors.filter((e) => e.kind === 'storage')).toEqual([]);
    expect(report.storage).not.toBeNull();
    expect(reads.strict).toBe(0);
  });

  it('reads a host without listScopesReadable through listScopes, strict as before', async () => {
    const { host, reads } = hostWith(good, [row('')], { readable: false });
    await expect(runPlatformSweep(host, { actor: ACTOR, fetch: FETCH, sweepers: {} })).rejects.toThrow(/does not parse/);
    expect(reads.strict).toBe(1);
  });
});
