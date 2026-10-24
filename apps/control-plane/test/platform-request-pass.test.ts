import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';
import {
  platformActorId,
  platformRequestId,
  principalId,
  PROVISION_SIBLING_KIND,
  scopeId,
  tenantId,
  type ScopeId,
  type ScopeStatus,
  type TenantId,
} from '@substrat-run/contracts';
import { ControlPlaneError, VerticalClient, drainScopePlatformRequests } from '@substrat-run/control-plane-api';
import {
  INERT_SCOPE_REASON,
  StorageReadUnsupported,
  globalFetch,
  runPlatformSweep,
  scopeNotHeldRefusal,
  ulid,
  type PlatformSweepReport,
} from '@substrat-run/kernel';
import worker, {
  attachmentReaderFor,
  drainContextOf,
  drainTarget,
  meterSnapshotLogOf,
  oncePerScope,
  platformRequestSweepRun,
  recordPlatformRequestPass,
  requestRollupFor,
  requestRollupLogOf,
  storageReaderFor,
  storeStorageReaderFor,
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
      unsettleable: expect.any(Number),
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
  const totals = { scopes: 2, drained: 6, done: 3, failed: 1, pending: 2, skipped: 0, unreachable: 0, unsettleable: 0 };
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

  it('an intent no drain could settle fails the row on every pass, and says where to look (#1637)', () => {
    const run = platformRequestSweepRun(report({ platformRequestTotals: { ...totals, unsettleable: 2 } }), AT);
    expect(run.outcome).toBe('failed');
    expect(run.error).toBe(
      '2 pending intent(s) cannot be run or settled — the row did not decode and its stored id is not an id; the platform-sweep log names each scope',
    );
    // Not a floor: those intents are counted, not missing, so the queue wording stays out of it.
    expect(run.error).not.toMatch(/not in these totals/);
  });

  it('beside a floor, both are said', () => {
    const run = platformRequestSweepRun(report({ platformRequestTotals: { ...totals, unreachable: 1, unsettleable: 1 } }), AT);
    expect(run.error).toMatch(/^1 scope\(s\) had no reachable deployment — their queues are not in these totals; 1 pending intent\(s\) cannot be run or settled/);
  });

  it("another phase's error does not — it says nothing about the drain's reach", () => {
    expect(platformRequestSweepRun(report({ errors: [{ kind: 'sweep', id: 'c1', error: 'boom' }] }), AT).outcome).toBe('ok');
  });
});

describe('recordPlatformRequestPass (#1840)', () => {
  const report = {
    platformRequestTotals: { scopes: 0, drained: 0, done: 0, failed: 0, pending: 0, skipped: 0, unreachable: 0, unsettleable: 0 },
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

  /** A real `VerticalClient` whose deployment answers `res` — the producer the reader classifies. */
  const answeredBy = (res: () => Response) =>
    storageReaderFor(
      async () =>
        new VerticalClient({ fetch: (async () => res()) as unknown as typeof fetch, platformSecret: 'secret' }),
    );
  const erroredBody = (status: number) => () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.error(new Error('stream broke'));
        },
      }),
      { status },
    );

  it('turns a deployment without the route (501, or a plain-text route miss) into the standing condition', async () => {
    for (const [status, res] of [
      [501, () => Response.json({ error: 'this deployment cannot read a database size (#1524). Redeploy it' }, { status: 501 })],
      [404, () => new Response('404 Not Found', { status: 404 })], // Hono's own miss: no route at all
    ] as const) {
      const err = await answeredBy(res)(scope('todo')).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StorageReadUnsupported);
      expect((err as Error).message).toMatch(new RegExp(`vertical 'todo' cannot read a database size \\(${status}\\)`));
    }
  });

  it("passes an enveloped, an empty or an unread 404, and any other failure, on as real failures", async () => {
    // The twins of the route miss: the vertical HAS the route and answered with its envelope,
    // or the body proves nothing either way.
    for (const res of [
      () => Response.json({ error: 'unknown scope 01J…' }, { status: 404 }),
      () => new Response('', { status: 404 }),
      () => new Response('   ', { status: 404 }),
      erroredBody(404),
      () => new Response('upstream unavailable', { status: 503 }),
    ]) {
      const err = await answeredBy(res)(scope('todo')).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ControlPlaneError);
      expect(err).not.toBeInstanceOf(StorageReadUnsupported);
    }
  });

  it("skips a deployment's 'not held' 409 only for a scope the directory has reaped, archived or lost, and keeps every other status an error (#2541)", async () => {
    const s = scope('todo');
    const notHeld = () => Response.json({ error: scopeNotHeldRefusal(s.id) }, { status: 409 });
    const reader = (record: () => Promise<{ status: ScopeStatus } | undefined>) =>
      storageReaderFor(
        async () => new VerticalClient({ fetch: (async () => notHeld()) as unknown as typeof fetch, platformSecret: 'secret' }),
        record,
      );
    for (const status of ['reaped', 'archived'] as const) {
      await expect(reader(async () => ({ status }))(s)).resolves.toBeNull();
    }
    await expect(reader(async () => undefined)(s)).resolves.toBeNull();
    for (const status of ['provisioning', 'active', 'suspended', 'archiving'] as const) {
      const err = await reader(async () => ({ status }))(s).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ControlPlaneError);
      expect(err).not.toBeInstanceOf(StorageReadUnsupported);
    }
    // Without a directory to ask, the answer is an error, as before.
    expect(await answeredBy(notHeld)(s).catch((e: unknown) => e)).toBeInstanceOf(ControlPlaneError);
    // A 409 that is some other conflict is never taken for it, whatever the directory says.
    const other = storageReaderFor(
      async () =>
        new VerticalClient({
          fetch: (async () => Response.json({ error: 'something else conflicted' }, { status: 409 })) as unknown as typeof fetch,
          platformSecret: 'secret',
        }),
      async () => undefined,
    );
    expect(await other(s).catch((e: unknown) => e)).toBeInstanceOf(ControlPlaneError);
  });

  it('a failing directory read is an error of that scope, never a skip', async () => {
    const s = scope('todo');
    const read = storageReaderFor(
      async () =>
        new VerticalClient({
          fetch: (async () => Response.json({ error: scopeNotHeldRefusal(s.id) }, { status: 409 })) as unknown as typeof fetch,
          platformSecret: 'secret',
        }),
      async () => Promise.reject(new Error('directory unavailable')),
    );
    await expect(read(s)).rejects.toThrow(/directory unavailable/);
  });

  it('asks the directory only after a not-held answer', async () => {
    let asked = 0;
    const read = storageReaderFor(
      async () => new VerticalClient({ fetch: (async () => Response.json({ bytes: 4_096 })) as unknown as typeof fetch, platformSecret: 'secret' }),
      async () => ((asked += 1), undefined),
    );
    await expect(read(scope('todo'))).resolves.toBe(4_096);
    expect(asked).toBe(0);
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

describe('attachmentReaderFor (#2501)', () => {
  const scope = (vertical: string | null) =>
    ({ id: scopeId.parse(ulid()), tenantId: tenantId.parse(ulid()), vertical }) as unknown as Parameters<
      ReturnType<typeof attachmentReaderFor>
    >[0];
  const answeredBy = (res: () => Response) =>
    attachmentReaderFor(
      async () => new VerticalClient({ fetch: (async () => res()) as unknown as typeof fetch, platformSecret: 'secret' }),
    );

  it("reads through the deployment that resolves for the scope, and fails when none does", async () => {
    const s = scope('todo');
    await expect(answeredBy(() => Response.json({ bytes: 2_048 }))(s)).resolves.toBe(2_048);
    await expect(attachmentReaderFor(async () => undefined)(s)).rejects.toThrow(/no deployment resolves for vertical 'todo'/);
  });

  it('turns a deployment without the route (501, or a plain-text route miss) into the standing condition, never 0', async () => {
    for (const [status, res] of [
      [501, () => Response.json({ error: 'this deployment cannot read attachment bytes (#2501). Redeploy it' }, { status: 501 })],
      [404, () => new Response('404 Not Found', { status: 404 })],
    ] as const) {
      const err = await answeredBy(res)(scope('todo')).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StorageReadUnsupported);
      expect((err as Error).message).toMatch(new RegExp(`vertical 'todo' cannot read attachment bytes \\(${status}\\); redeploy it`));
    }
  });

  it('passes an enveloped 404 and any other failure on as real failures, and skips a scope with no vertical', async () => {
    for (const res of [() => Response.json({ error: 'unknown scope' }, { status: 404 }), () => new Response('down', { status: 503 })]) {
      const err = await answeredBy(res)(scope('todo')).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ControlPlaneError);
      expect(err).not.toBeInstanceOf(StorageReadUnsupported);
    }
    let resolved = 0;
    const read = attachmentReaderFor(async () => ((resolved += 1), undefined));
    await expect(read(scope(null))).resolves.toBeNull();
    expect(resolved).toBe(0);
  });

  it("applies the same rule to the attachment read: skipped for archived, an error for active or a failing directory (#2541)", async () => {
    const s = scope('todo');
    const client = () =>
      new VerticalClient({
        fetch: (async () => Response.json({ error: scopeNotHeldRefusal(s.id) }, { status: 409 })) as unknown as typeof fetch,
        platformSecret: 'secret',
      });
    await expect(attachmentReaderFor(async () => client(), async () => ({ status: 'archived' as const }))(s)).resolves.toBeNull();
    await expect(attachmentReaderFor(async () => client(), async () => undefined)(s)).resolves.toBeNull();
    for (const status of ['provisioning', 'active', 'suspended', 'archiving'] as const) {
      expect(await attachmentReaderFor(async () => client(), async () => ({ status }))(s).catch((e: unknown) => e)).toBeInstanceOf(ControlPlaneError);
    }
    await expect(attachmentReaderFor(async () => client(), async () => Promise.reject(new Error('directory unavailable')))(s)).rejects.toThrow(
      /directory unavailable/,
    );
  });

  it('shares one deployment lookup per scope with the database read, through oncePerScope', async () => {
    const asked: string[] = [];
    const client = new VerticalClient({
      fetch: (async () => Response.json({ bytes: 4_096 })) as unknown as typeof fetch,
      platformSecret: 'secret',
    });
    const deployment = oncePerScope(async (s: { id: string }) => (asked.push(s.id), client));
    const [a, b] = [scope('todo'), scope('todo')];
    await storageReaderFor(deployment)(a);
    await attachmentReaderFor(deployment)(a);
    expect(asked).toEqual([a.id]);
    // Its twin: another scope climbs the ladder for itself.
    await attachmentReaderFor(deployment)(b);
    expect(asked).toEqual([a.id, b.id]);
  });
});

describe('storeStorageReaderFor (#2212)', () => {
  const scope = (vertical: string | null) =>
    ({ id: scopeId.parse(ulid()), tenantId: tenantId.parse(ulid()), vertical }) as unknown as Parameters<
      ReturnType<typeof storeStorageReaderFor>
    >[0];

  it('turns a 501 and a route miss into the standing condition', async () => {
    for (const status of [501, 404] as const) {
      const read = storeStorageReaderFor(async () => {
        throw new ControlPlaneError(
          status,
          status === 404 ? '404 Not Found' : 'cannot read scope store sizes',
          undefined,
          status === 404 ? { body: '404 Not Found' } : {},
        );
      });
      const err = await read(scope('todo')).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StorageReadUnsupported);
      expect((err as Error).message).toMatch(new RegExp(`cannot read scope store sizes \\(${status}\\)`));
    }
  });

  it('passes any other failure on, and skips a scope with no vertical', async () => {
    const read = storeStorageReaderFor(async () => {
      throw new ControlPlaneError(503, 'upstream unavailable');
    });
    const err = await read(scope('todo')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ControlPlaneError);
    expect(err).not.toBeInstanceOf(StorageReadUnsupported);
    let resolved = 0;
    const skip = storeStorageReaderFor(async () => {
      resolved += 1;
      return [];
    });
    await expect(skip(scope(null))).resolves.toBeNull();
    expect(resolved).toBe(0);
  });
});

describe('requestRollupFor (#2501)', () => {
  const configured = { CF_API_TOKEN: 'tok', CF_ACCOUNT_ID: 'acct', ROUTER_ANALYTICS_DATASET: 'substrat_router_test' };

  it('runs no rollup without the credential, the account or the router dataset', () => {
    expect(requestRollupFor({ ...configured, CF_API_TOKEN: undefined })).toBeUndefined();
    expect(requestRollupFor({ ...configured, CF_ACCOUNT_ID: undefined })).toBeUndefined();
    // Never defaulted: TEST must not read production's dataset as its own.
    expect(requestRollupFor({ ...configured, ROUTER_ANALYTICS_DATASET: undefined })).toBeUndefined();
  });

  it('with all three, reads one day of the named dataset through the Analytics Engine API', async () => {
    const rollup = requestRollupFor(configured);
    expect(rollup).toBeDefined();
    const asked: { url: string; sql: string }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      asked.push({ url: String(url), sql: String(init?.body ?? '') });
      return new Response(JSON.stringify({ data: [] }));
    }) as typeof fetch;
    try {
      await expect(rollup!.read('2026-10-21')).resolves.toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(asked).toHaveLength(1);
    expect(asked[0]!.url).toBe('https://api.cloudflare.com/client/v4/accounts/acct/analytics_engine/sql');
    expect(asked[0]!.sql).toContain('FROM substrat_router_test');
  });
});

describe('requestRollupLogOf: a standing rollup failure stays in the pass log (#2501)', () => {
  const base = { due: 0, deferred: 0, read: 0, failed: 0, repeated: 0, streak: null, saturated: 0, saturatedDays: [], recorded: 0, pruned: 0 };

  it('says nothing for a pass the rollup did nothing in', () => {
    expect(requestRollupLogOf(null)).toBeNull();
    expect(requestRollupLogOf(undefined)).toBeNull();
    expect(requestRollupLogOf({ ...base, due: 3, deferred: 0 })).toBeNull();
  });

  it('names days read, a failing run with its start and length, and days found saturated', () => {
    expect(requestRollupLogOf({ ...base, read: 2, recorded: 5 })).toEqual({ read: 2, recorded: 5 });
    const streak = { error: 'HTTP 403', since: '2026-10-23T12:00:00.000Z', failures: 4 };
    expect(requestRollupLogOf({ ...base, failed: 1, repeated: 1, streak })).toEqual({ read: 0, recorded: 0, failing: streak });
    // A pass between the run's retries reads nothing and still names it.
    expect(requestRollupLogOf({ ...base, streak })).toEqual({ read: 0, recorded: 0, failing: streak });
    expect(requestRollupLogOf({ ...base, saturated: 1, saturatedDays: ['2026-10-21'] })).toEqual({
      read: 0,
      recorded: 0,
      saturatedDays: ['2026-10-21'],
    });
  });

  it('on the directory DO: the second pass of a standing failure mails nothing, and its log line still names the run', async () => {
    const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
    const staff = platformActorId.parse(ulid());
    // Days no other test of this pool touches: the rollup's record of a day is fleet-wide.
    const pass = (now: string) =>
      runPlatformSweep(host, {
        actor: staff,
        fetch: globalFetch,
        sweepers: {},
        drainRetries: false,
        // Only the rollup is under test: leave the shared directory's scopes alone.
        reconcileMigrations: false,
        runSchedules: false,
        requestRollup: {
          lookbackDays: 2,
          now: () => now,
          read: async () => {
            throw new Error('Cloudflare Analytics Engine query failed: HTTP 403 Authentication error');
          },
        },
      });
    const first = await pass('2034-03-10T12:00:00.000Z');
    expect(first.errors.filter((e) => e.kind === 'request-rollup')).toHaveLength(1);
    const second = await pass('2034-03-10T12:15:00.000Z');
    expect(second.errors.filter((e) => e.kind === 'request-rollup')).toEqual([]);
    expect(requestRollupLogOf(second.requestRollup)).toEqual({
      read: 0,
      recorded: 0,
      failing: { error: expect.stringMatching(/HTTP 403/), since: '2034-03-10T12:00:00.000Z', failures: 2 },
    });
    // Both days were tried within the hour, so the third pass has nothing to retry: it takes the
    // run from the ledger, adds no attempt and mails nothing, and its log line still names it.
    const third = await pass('2034-03-10T12:30:00.000Z');
    expect(third.requestRollup).toMatchObject({ due: 0, read: 0, failed: 0 });
    expect(third.errors.filter((e) => e.kind === 'request-rollup')).toEqual([]);
    expect(requestRollupLogOf(third.requestRollup)).toEqual({
      read: 0,
      recorded: 0,
      failing: { error: expect.stringMatching(/HTTP 403/), since: '2034-03-10T12:00:00.000Z', failures: 2 },
    });
  });
});

/**
 * The hostname reconcile is one step of the scheduled pass, and a throw for the whole step (here,
 * a hostname row its read cannot parse) is logged as that step's failure: the steps after it, the
 * directory backup and the stored-copy prune, still run. Driven through the real `scheduled`
 * against the real directory, with a Cloudflare-for-SaaS zone configured so the step runs at all,
 * and a recording backup bucket so the backup step is observed without touching the shared one.
 */
describe('the scheduled pass runs the steps after a failed hostname reconcile', () => {
  const staff = platformActorId.parse(ulid());
  const cp = () => env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName('control-plane'));
  const hostname = `unparsable-${ulid().toLowerCase()}.global.substrat.run`;

  /** A bucket the backup step writes to, recording each key it puts. */
  const recordingBucket = (puts: string[]) => ({
    put: async (key: string) => void puts.push(key),
    get: async () => null,
    delete: async () => {},
    list: async () => ({ objects: [], truncated: false }),
  });

  beforeAll(async () => {
    await warmControlPlane(env.CONTROL_PLANE);
  });

  it('logs the hostname step as failed and still takes the directory backup', async () => {
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
    await host.admin.createTenant(staff, { id: t, slug: `hostname-step-${t.slice(-8).toLowerCase()}`, name: 'Hostname step' });
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'todo' });
    // A row the hostname read cannot parse: a status outside the enum.
    await runInDurableObject(cp(), (_i, state) => {
      state.storage.sql.exec(
        "INSERT INTO hostnames (hostname, tenant_id, scope_id, surface, status, created_at) VALUES (?, ?, ?, 'app', 'unparsable', ?)",
        hostname, t, s, new Date().toISOString(),
      );
    });
    const errors = vi.spyOn(console, 'error');
    const puts: string[] = [];
    try {
      await worker.scheduled({} as ScheduledController, {
        ...env,
        CF_API_TOKEN: 'test-token',
        CF_SAAS_ZONE_ID: 'test-zone',
        DIRECTORY_BACKUPS: recordingBucket(puts),
      } as never);
      expect(errors).toHaveBeenCalledWith('hostname-reconcile failed', expect.any(String));
      // The directory copy, written after the hostname step (the bucket also takes other objects).
      expect(puts.filter((k) => k.startsWith('directory/'))).toHaveLength(1);
    } finally {
      errors.mockRestore();
      await runInDurableObject(cp(), (_i, state) => {
        state.storage.sql.exec('DELETE FROM hostnames WHERE hostname = ?', hostname);
      });
    }
  });
});

describe('the daily meter snapshot in the scheduled pass (#2501)', () => {
  const base = { day: '2026-10-23', taken: false, tenants: 0, failed: 0, repeated: 0, streak: null, pruned: 0 };

  it('the log line says nothing for a pass that took nothing and is not failing', () => {
    expect(meterSnapshotLogOf(null)).toBeNull();
    expect(meterSnapshotLogOf(undefined)).toBeNull();
    // A later pass of a day already taken.
    expect(meterSnapshotLogOf(base)).toBeNull();
    // A prune alone is not worth a line.
    expect(meterSnapshotLogOf({ ...base, pruned: 4 })).toBeNull();
  });

  it('the log line names the day taken with its tenants, and a failing run with its start and length', () => {
    expect(meterSnapshotLogOf({ ...base, taken: true, tenants: 7 })).toEqual({ day: '2026-10-23', tenants: 7 });
    const streak = { error: 'directory busy', since: '2026-10-22T23:45:00.000Z', failures: 3 };
    // Repeated, so not in the digest: the line is where the run stays visible.
    expect(meterSnapshotLogOf({ ...base, failed: 1, repeated: 1, streak })).toEqual({ day: '2026-10-23', failing: streak });
  });

  it('on the directory DO, the real scheduled pass takes the day it runs in', async () => {
    const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
    const staff = platformActorId.parse(ulid());
    await warmControlPlane(env.CONTROL_PLANE);
    const before = new Date().toISOString().slice(0, 10);
    await worker.scheduled({} as ScheduledController, env as never);
    const after = new Date().toISOString().slice(0, 10);
    // The directory persists across this pool's files, so an earlier file's pass may have taken the
    // day already: what holds either way is that the day is taken, at an instant inside it.
    const takes = await host.admin.listMeterDayTakes!(staff, { since: before, until: after });
    expect(takes.some((t) => t.error === null && t.takenAt?.slice(0, 10) === t.day)).toBe(true);
  });
});
