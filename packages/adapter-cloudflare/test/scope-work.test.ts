/**
 * Platform work inside a tenant's scope (#3316), on a real Durable Object: each RPC entry's rows,
 * read off the runtime's own cursors, leave as one Analytics Engine point per invocation under the
 * entry's origin. `MeteredScopeDO` (test/worker.ts) records the points where a hosted object would
 * write them; `UnmeteredScopeDO` is the same class with no dataset, the overhead probe's baseline.
 */
import { env } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { permissionKey, principalId, scopeId, tenantId, type ScopeId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { SCOPE_WORK_DATA_POINT_LAYOUT } from '../src/scope-work.js';
import { CloudflareScopeHost } from './test-host.js';
import { SCOPE_WORK_POINTS, SCOPE_WORK_REFUSES } from './worker.js';

declare const __PROBE_SCOPE_WORK__: boolean;

type Point = { indexes: string[]; blobs: string[]; doubles: number[] };
const g = globalThis as unknown as Record<symbol, unknown>;
const pointsOf = (s: string, ns = env.METERED_SCOPE): Point[] => {
  const object = ns.idFromName(s).toString();
  return ((g[SCOPE_WORK_POINTS] ?? []) as Point[]).filter((p) => p.blobs[2] === object);
};
/** A point's blobs as named fields, and whether it counted anything at all. */
const named = (p: Point) => ({ origin: p.blobs[5], entry: p.blobs[6], written: p.doubles[0]!, read: p.doubles[1]!, statements: p.doubles[2]! });
const USE = permissionKey.parse('perm:use');

describe('scope work: rows per invocation, by origin (#3316)', () => {
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const owner = principalId.parse(ulid());
  const hostOn = (ns: DurableObjectNamespace) => new CloudflareScopeHost({ scope: ns });
  const provision = (ns: DurableObjectNamespace, scope: ScopeId) =>
    hostOn(ns).provisionScopeLocal({
      tenantId: t,
      scopeId: scope,
      owner,
      roles: [{ key: 'office-admin', permissions: [USE], source: 'vertical' }],
      ownerRoleKey: 'office-admin',
    });
  const emit = async (ns: DurableObjectNamespace, scope: ScopeId) =>
    (await hostOn(ns).getScope(owner, t, scope)).invoke('perm/authorized-emit', { permission: USE });

  beforeAll(() => provision(env.METERED_SCOPE, s));
  afterEach(() => {
    g[SCOPE_WORK_REFUSES] = undefined;
  });

  it('pins every ordinal to its name, unit and absent value — grow-only', () => {
    expect(SCOPE_WORK_DATA_POINT_LAYOUT).toEqual({
      indexes: [{ ordinal: 'index1', name: 'substrat.tenant.id', unit: null, absent: '' }],
      blobs: [
        { ordinal: 'blob1', name: 'substrat.vertical', unit: null, absent: '' },
        { ordinal: 'blob2', name: 'substrat.scope.id', unit: null, absent: '' },
        { ordinal: 'blob3', name: 'durable_object.id', unit: null, absent: '' },
        { ordinal: 'blob4', name: 'substrat.version.id', unit: null, absent: '' },
        { ordinal: 'blob5', name: 'substrat.deployment.kind', unit: null, absent: '' },
        { ordinal: 'blob6', name: 'substrat.scope_work.origin', unit: null, absent: '' },
        { ordinal: 'blob7', name: 'substrat.scope_work.entry', unit: null, absent: '' },
      ],
      doubles: [
        { ordinal: 'double1', name: 'db.rows_written', unit: '{row}', absent: 0 },
        { ordinal: 'double2', name: 'db.rows_read', unit: '{row}', absent: 0 },
        { ordinal: 'double3', name: 'db.statements', unit: '{statement}', absent: 0 },
      ],
    });
  });

  it("counts a call's rows per entry: the admission as `request`, the operation as `operation`", async () => {
    const before = pointsOf(s).length;
    await emit(env.METERED_SCOPE, s);
    const mine = pointsOf(s).slice(before);
    expect(mine.map((p) => [p.blobs[5], p.blobs[6]])).toEqual([
      ['request', 'admission'],
      ['operation', 'invoke'],
    ]);
    const invoke = mine[1]!;
    expect(invoke.indexes).toEqual([t]);
    expect(invoke.blobs.slice(0, 5)).toEqual([
      'acme',
      s,
      env.METERED_SCOPE.idFromName(s).toString(),
      '01JTESTVRSN0000000000000AA',
      'preview',
    ]);
    // An emitting operation writes its row and its outbox event, and reads its checks.
    expect(Math.min(...invoke.doubles)).toBeGreaterThan(0);
  });

  it('counts a nested entry, across its await, with the entry that called it', async () => {
    const before = pointsOf(s).length;
    const stub = env.METERED_SCOPE.get(env.METERED_SCOPE.idFromName(s)) as unknown as {
      introspectTablesIfHeld(): Promise<unknown>;
    };
    expect(await stub.introspectTablesIfHeld()).not.toBeNull();
    expect(pointsOf(s).slice(before).map(named)).toEqual([
      expect.objectContaining({ origin: 'observe', entry: 'introspectTablesIfHeld' }),
    ]);
  });

  it('counts the wake and the migration pass an operation woke apart from the operation', async () => {
    // A fresh object: its first invoke wakes it and runs every migration before it is refused.
    const fresh = scopeId.parse(ulid());
    const stub = env.METERED_SCOPE.get(env.METERED_SCOPE.idFromName(fresh)) as unknown as {
      invoke(...args: unknown[]): Promise<unknown>;
    };
    await stub.invoke('perm/authorized-emit', { permission: USE }, owner, t, fresh).catch(() => undefined);
    // The wake's point is written after the constructor's turn, and the invoke may answer first.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const byEntry = new Map(pointsOf(fresh).map((p) => [named(p).entry, named(p)]));
    expect(byEntry.get('wake')).toMatchObject({ origin: 'wake' });
    expect(byEntry.get('migration-pass')).toMatchObject({ origin: 'migration' });
    expect(byEntry.get('migration-pass')!.written).toBeGreaterThan(0);
    // The invoke's own point holds what the refusal read, never the pass's writes.
    expect(byEntry.get('invoke')?.written ?? 0).toBeLessThan(byEntry.get('migration-pass')!.written);
  });

  it('a dataset that refuses the point does not fail the work it counted', async () => {
    g[SCOPE_WORK_REFUSES] = true;
    const before = pointsOf(s).length;
    await emit(env.METERED_SCOPE, s);
    expect(pointsOf(s)).toHaveLength(before);
  });
});

/**
 * The overhead on the hot path, measured, not asserted (opt in: `SUBSTRAT_PROBE_SCOPE_WORK=1`).
 * The same operation on the same class, with and without a dataset bound, interleaved in rounds so
 * a warm-up or a slow moment lands on both.
 */
describe.skipIf(!__PROBE_SCOPE_WORK__)('scope work: the overhead (opt in, #3316)', () => {
  it('times an emitting operation metered and unmetered', async () => {
    const t = tenantId.parse(ulid());
    const owner = principalId.parse(ulid());
    const scopes = { metered: scopeId.parse(ulid()), unmetered: scopeId.parse(ulid()) };
    const ns = { metered: env.METERED_SCOPE, unmetered: env.UNMETERED_SCOPE };
    const hosts = { metered: new CloudflareScopeHost({ scope: ns.metered }), unmetered: new CloudflareScopeHost({ scope: ns.unmetered }) };
    for (const k of ['metered', 'unmetered'] as const) {
      await hosts[k].provisionScopeLocal({
        tenantId: t,
        scopeId: scopes[k],
        owner,
        roles: [{ key: 'office-admin', permissions: [USE], source: 'vertical' }],
        ownerRoleKey: 'office-admin',
      });
    }
    const handles = {
      metered: await hosts.metered.getScope(owner, t, scopes.metered),
      unmetered: await hosts.unmetered.getScope(owner, t, scopes.unmetered),
    };
    const ms = { metered: [] as number[], unmetered: [] as number[] };
    const ROUNDS = 10;
    const PER_ROUND = 50;
    for (let round = 0; round < ROUNDS; round++) {
      for (const k of round % 2 ? (['metered', 'unmetered'] as const) : (['unmetered', 'metered'] as const)) {
        const started = performance.now();
        for (let i = 0; i < PER_ROUND; i++) await handles[k].invoke('perm/authorized-emit', { permission: USE });
        ms[k].push((performance.now() - started) / PER_ROUND);
      }
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const points = pointsOf(scopes.metered).filter((p) => p.blobs[6] === 'invoke').map(named);
    console.log(
      JSON.stringify({
        perInvokeMs: { metered: median(ms.metered), unmetered: median(ms.unmetered) },
        overheadPct: ((median(ms.metered) - median(ms.unmetered)) / median(ms.unmetered)) * 100,
        perInvoke: points.at(-1),
      }),
    );
  }, 120_000);
});
