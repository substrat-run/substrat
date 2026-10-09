import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';
import {
  platformActorId,
  platformRequestId,
  principalId,
  PROVISION_SIBLING_KIND,
  scopeId,
  tenantId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { ControlPlaneError, drainScopePlatformRequests } from '@substrat-run/control-plane-api';
import { INERT_SCOPE_REASON, StorageReadUnsupported, ulid, type PlatformSweepReport } from '@substrat-run/kernel';
import worker, {
  drainContextOf,
  drainTarget,
  platformRequestSweepRun,
  recordPlatformRequestPass,
  storageReaderFor,
  timedDrain,
} from '../src/worker.js';
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

/**
 * #2005 — the drain's context comes from the scope's directory record, and `primary` is the
 * field a wrong answer turns into an outbound effect. Read from the real directory Durable
 * Object, for every shape of copy the platform makes, and then handed to the real drain: a
 * copy's own intent is settled inert, and the install's runs.
 */
describe('drainContextOf: a copy of a scope drains inert (#2005)', () => {
  const staff = platformActorId.parse(ulid());
  const host = () => new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
  const t = tenantId.parse(ulid());
  const vertical = 'acme/crm';
  const scopes: Record<'install' | 'previewFork' | 'cleanRoom' | 'snapshot', ScopeId> = {} as never;

  beforeAll(async () => {
    await warmControlPlane(env.CONTROL_PLANE);
    const h = host();
    await h.admin.createTenant(staff, { id: t, slug: `inert-${t.toLowerCase()}`, name: 'Inert' });
    const provision = async (extra: Record<string, unknown> = {}): Promise<ScopeId> => {
      const s = scopeId.parse(ulid());
      await h.provisionScope(staff, { tenantId: t, scopeId: s, vertical, ...extra });
      await h.admin.activateScope(staff, t, s);
      return s;
    };
    scopes.install = await provision();
    scopes.previewFork = await provision({ kind: 'preview', forkedFrom: scopes.install, forkedAt: new Date().toISOString() });
    scopes.cleanRoom = await provision({ kind: 'preview' });
    scopes.snapshot = await h.snapshotScope(staff, t, scopes.install);
  });

  const drainOne = async (s: ScopeId) => {
    const rec = await host().admin.getScopeRecord(staff, t, s);
    const ctx = drainContextOf(rec!, vertical, await host().admin.getTenant(staff, t));
    let ran = 0;
    const settled: { status: string; lastError: string | null }[] = [];
    const client = {
      listPlatformRequests: async () => [
        {
          id: platformRequestId.parse(ulid()),
          kind: PROVISION_SIBLING_KIND,
          payload: {},
          requestedBy: principalId.parse(ulid()),
          status: 'pending',
          attempts: 0,
          lastError: null,
          result: null,
          requestedAt: new Date().toISOString(),
          settledAt: null,
        },
      ],
      settlePlatformRequest: async (_t: unknown, _s: unknown, _id: unknown, o: { status: string; lastError: string | null }) =>
        void settled.push(o),
    } as never;
    await drainScopePlatformRequests(client, ctx, { [PROVISION_SIBLING_KIND]: async () => (ran++, { status: 'done' }) });
    return { ctx, ran, settled };
  };

  it('twin: the install carries its own kind and lineage, and its intent runs', async () => {
    const { ctx, ran, settled } = await drainOne(scopes.install);
    expect(ctx).toEqual({
      tenantId: t,
      scopeId: scopes.install,
      vertical,
      versionId: null,
      scope: { kind: 'scope', forkedFrom: null },
      lifecycle: { scope: 'active', tenant: 'active' },
    });
    expect(ran).toBe(1);
    expect(settled).toEqual([expect.objectContaining({ status: 'done' })]);
  });

  for (const shape of ['previewFork', 'cleanRoom', 'snapshot'] as const) {
    it(`${shape}: its own intent is settled inert without running`, async () => {
      const { ctx, ran, settled } = await drainOne(scopes[shape]);
      expect(ran).toBe(0);
      expect(settled).toEqual([expect.objectContaining({ status: 'failed', lastError: INERT_SCOPE_REASON })]);
    });
  }
});

/**
 * #1713: the drain's lifecycle read from the real directory Durable Object. A suspended scope, and a
 * live scope under a suspended tenant, carry their status into the context, and the real drain then
 * leaves the intent pending without running it. A tenant with no record fails closed.
 */
describe('drainContextOf: a held scope\'s intents wait (#1713)', () => {
  const staff = platformActorId.parse(ulid());
  const host = () => new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
  const vertical = 'acme/crm';

  beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

  const live = async () => {
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    await host().admin.createTenant(staff, { id: t, slug: `held-${t.toLowerCase()}`, name: 'Held' });
    await host().provisionScope(staff, { tenantId: t, scopeId: s, vertical });
    await host().admin.activateScope(staff, t, s);
    return { t, s };
  };
  const drainOne = async (t: TenantId, s: ScopeId) => {
    const ctx = drainContextOf(
      (await host().admin.getScopeRecord(staff, t, s))!,
      vertical,
      await host().admin.getTenant(staff, t),
    );
    let ran = 0;
    const settled: unknown[] = [];
    const client = {
      listPlatformRequests: async () => [
        {
          id: platformRequestId.parse(ulid()),
          kind: PROVISION_SIBLING_KIND,
          payload: {},
          requestedBy: principalId.parse(ulid()),
          status: 'pending',
          attempts: 0,
          lastError: null,
          result: null,
          requestedAt: new Date().toISOString(),
          settledAt: null,
        },
      ],
      settlePlatformRequest: async (...a: unknown[]) => void settled.push(a),
    } as never;
    const report = await drainScopePlatformRequests(client, ctx, { [PROVISION_SIBLING_KIND]: async () => (ran++, { status: 'done' }) });
    return { ctx, report, ran, settled };
  };

  it('a suspended scope: held, nothing run, nothing settled; unsuspended, it runs', async () => {
    const { t, s } = await live();
    await host().admin.suspendScope(staff, t, s);
    const held = await drainOne(t, s);
    expect(held.ctx.lifecycle).toEqual({ scope: 'suspended', tenant: 'active' });
    expect(held.report).toEqual({ drained: 0, done: 0, failed: 0, pending: 1, held: true });
    expect([held.ran, held.settled.length]).toEqual([0, 0]);
    await host().admin.unsuspendScope(staff, t, s);
    const resumed = await drainOne(t, s);
    expect([resumed.ran, resumed.report.done]).toEqual([1, 1]);
  });

  it('a live scope under a suspended tenant: held by the tenant', async () => {
    const { t, s } = await live();
    await host().admin.setTenantStatus(staff, t, 'suspended');
    const held = await drainOne(t, s);
    expect(held.ctx.lifecycle).toEqual({ scope: 'active', tenant: 'suspended' });
    expect([held.report.held, held.ran]).toEqual([true, 0]);
    await host().admin.setTenantStatus(staff, t, 'active');
    expect((await drainOne(t, s)).ran).toBe(1);
  });

  it('a tenant with no record fails closed', () => {
    const ctx = drainContextOf(
      { tenantId: tenantId.parse(ulid()), id: scopeId.parse(ulid()), verticalVersionId: null, kind: 'scope', forkedFrom: null, status: 'active' },
      vertical,
      undefined,
    );
    expect(ctx.lifecycle).toEqual({ scope: 'active', tenant: 'reaped' });
  });
});

/**
 * #1524 — the storage-gauge phase's hosted reader. A scope's DO lives in its vertical's
 * deployment, so the size is read there; never from this plane's placeholder namespace.
 */
describe('storageReaderFor (#1524)', () => {
  const scope = (vertical: string | null) =>
    ({ id: scopeId.parse(ulid()), tenantId: tenantId.parse(ulid()), vertical }) as unknown as Parameters<
      ReturnType<typeof storageReaderFor>
    >[0];

  it('reads through the deployment that resolves for the scope', async () => {
    const asked: string[] = [];
    const s = scope('todo');
    const read = storageReaderFor(async () => ({
      databaseSize: async (id) => {
        asked.push(id);
        return 12_288;
      },
    }));
    await expect(read(s)).resolves.toBe(12_288);
    expect(asked).toEqual([s.id]);
  });

  it('fails, rather than reading a placeholder, when no deployment resolves', async () => {
    await expect(storageReaderFor(async () => undefined)(scope('todo'))).rejects.toThrow(/no deployment resolves for vertical 'todo'/);
  });

  it('turns a deployment without the route (501 or 404) into the standing condition, and passes other failures on', async () => {
    const failing = (status: number) =>
      storageReaderFor(async () => ({
        databaseSize: async () => {
          throw new ControlPlaneError(status, `vertical refused introspection: ${status}`);
        },
      }));
    for (const status of [501, 404]) {
      const err = await failing(status)(scope('todo')).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StorageReadUnsupported);
      expect((err as Error).message).toMatch(new RegExp(`vertical 'todo' cannot read a database size \\(${status}\\)`));
    }
    const other = await failing(503)(scope('todo')).catch((e: unknown) => e);
    expect(other).toBeInstanceOf(ControlPlaneError);
    expect(other).not.toBeInstanceOf(StorageReadUnsupported);
  });

  it('skips a scope bound to no vertical, without resolving anything', async () => {
    let resolved = 0;
    const read = storageReaderFor(async () => {
      resolved += 1;
      return undefined;
    });
    await expect(read(scope(null))).resolves.toBeNull();
    expect(resolved).toBe(0);
  });
});
