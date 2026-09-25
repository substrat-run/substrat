import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { CloudflareScopeHost } from '@substrat-run/adapter-cloudflare';
import {
  ControlPlaneError,
  VerticalClient,
  createControlPlaneApi,
  DEV_ACTOR_HEADER,
  UNSAFE_devPlatformActorAuth,
  provisionSiblingHandler,
  provisionTenantHandler,
  setEntitlementsHandler,
} from '@substrat-run/control-plane-api';
import {
  platformActorId,
  platformRequestId,
  principalId,
  scopeId,
  tenantId,
  type PlatformRequest,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { runPlatformSweep, ulid } from '@substrat-run/kernel';
import {
  assertReconcileReaches,
  parseReconcileBatch,
  reconcileOrUnsupported,
  reconcileReachedScope,
} from '../src/worker.js';
import { warmControlPlane } from './do-warmup.js';

/**
 * #1653 — a LISTED vertical's promote reaches its installs' provision, against the REAL
 * directory: the control plane's Durable Object, in workerd.
 *
 * A listed vertical's promote re-serves its stable script in place (#286) and moves no
 * install's version pointer, so the #1172 phase — comparing against the pointer — never
 * saw those installs. It now compares against the version each scope RUNS. What only the
 * real directory can show:
 *
 *   - an install born while the vertical serves in place carries the serving ref from its
 *     directory row's insert (`control-plane-do.ts`), which is what the comparison reads;
 *   - a FORK of that install inherits the same serving ref at insert — it is on the same
 *     script, on the same versions, and behind in exactly the same way. The only thing
 *     keeping it off the reconcile is the fork predicate, so this is where that predicate
 *     is proven load-bearing rather than merely present;
 *   - a clean-room preview inherits no serving ref (#527) and has no lineage either, so it
 *     is `kind` alone that excludes it.
 *
 * The directory persists across this pool's test files, so the sweep sees other files'
 * scopes too. Everything here asserts on this file's own scopes, and answers every other
 * scope `unsupported` — which writes nothing — so this suite changes no one else's rows.
 */
describe('provision reconcile follows the served version (#1653)', () => {
  const staff = platformActorId.parse(ulid());
  const suffix = ulid().toLowerCase();
  const LISTED = `listed-${suffix}`;
  const LISTED_REF = `listed-${suffix}-serving`;
  const PRIVATE = `own-${suffix}`;
  const PRIVATE_REF = `own-${suffix}-serving`;
  const A = tenantId.parse(ulid());
  const B = tenantId.parse(ulid());
  const OWNER = tenantId.parse(ulid());
  let v1: string;
  let v2: string;
  const s = {
    installA: scopeId.parse(ulid()),
    installB: scopeId.parse(ulid()),
    forkOfA: scopeId.parse(ulid()),
    cleanRoom: scopeId.parse(ulid()),
    ownScope: scopeId.parse(ulid()),
  };
  const mine = new Set<string>(Object.values(s));

  const hostOf = () => new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });

  const publish = async (host: CloudflareScopeHost, slug: string, version: string): Promise<string> => {
    const id = ulid();
    await host.admin.publishVersion(staff, {
      id,
      verticalSlug: slug,
      version,
      manifestDigest: `m-${version}`,
      permissionDigest: 'p',
      migrationDigest: 'g',
      deploymentRef: `${slug}-${version.replaceAll('.', '-')}`,
    });
    await host.admin.admitVersion(staff, id).catch(() => undefined); // a private one self-admits
    return id;
  };

  const scopeAt = async (
    host: CloudflareScopeHost,
    t: TenantId,
    id: ScopeId,
    vertical: string,
    version: string,
    extra: { forkedFrom?: ScopeId; kind?: string } = {},
  ) => {
    await host.provisionScope(staff, { tenantId: t, scopeId: id, vertical, ...extra });
    await host.admin.activateScope(staff, t, id);
    await host.admin.bindScopeVersion(staff, t, id, version);
  };

  /** One sweep pass over the real directory, recording which of OUR scopes it reconciled. */
  const pass = async (host: CloudflareScopeHost): Promise<string[]> => {
    const reached: string[] = [];
    await runPlatformSweep(host, {
      actor: staff,
      fetch: (() => Promise.reject(new Error('unused'))) as never,
      sweepers: {},
      drainRetries: false,
      runSchedules: false,
      reconcileMigrations: false,
      gcSnapshots: false,
      // Past whatever else this pool's directory holds, so the window is not the variable.
      provisionReconcileBatch: 10_000,
      reconcileScopeFn: async (_t, id) => {
        if (!mine.has(id)) return 'unsupported';
        reached.push(id);
      },
    });
    return reached.sort();
  };

  beforeAll(async () => {
    await warmControlPlane(env.CONTROL_PLANE);
    const host = hostOf();
    for (const [id, slug] of [[A, `a-${suffix}`], [B, `b-${suffix}`], [OWNER, `o-${suffix}`]] as const) {
      await host.admin.createTenant(staff, { id, slug, name: slug });
    }

    // A listed, platform-owned vertical, served in place at v1.
    await host.admin.registerVertical(staff, { slug: LISTED, name: 'Listed', source: 'cli', ownerTenant: null, listed: true });
    v1 = await publish(host, LISTED, '1.0.0');
    v2 = await publish(host, LISTED, '2.0.0');
    await host.admin.setVerticalServing(staff, LISTED, { ref: LISTED_REF, versionId: v1, doClasses: ['ScopeDO'], migrationTag: 'v1' });

    // Two tenants install it (born ON the serving script), and each provision ran at v1.
    await scopeAt(host, A, s.installA, LISTED, v1);
    await scopeAt(host, B, s.installB, LISTED, v1);
    // A restored copy of A's install, as a PR preview makes one, and a clean-room preview.
    await scopeAt(host, A, s.forkOfA, LISTED, v1, { forkedFrom: s.installA });
    await scopeAt(host, A, s.cleanRoom, LISTED, v2, { kind: 'preview' });
    for (const [t, id] of [[A, s.installA], [B, s.installB], [A, s.forkOfA]] as const) {
      await host.admin.markScopeProvisioned(staff, t, id, v1);
    }

    // A private vertical whose promote already moved its scope along, as it does today.
    await host.admin.registerVertical(staff, { slug: PRIVATE, name: 'Own', source: 'cli', ownerTenant: OWNER });
    const p1 = await publish(host, PRIVATE, '1.0.0');
    await host.admin.setVerticalServing(staff, PRIVATE, { ref: PRIVATE_REF, versionId: p1, doClasses: ['ScopeDO'], migrationTag: 'v1' });
    await scopeAt(host, OWNER, s.ownScope, PRIVATE, p1);
    await host.admin.markScopeProvisioned(staff, OWNER, s.ownScope, p1);
    await host.close();
  });

  it('reads the directory the way the comparison needs: installs AND their fork on the serving script, the preview not', async () => {
    const host = hostOf();
    const rec = (t: TenantId, id: ScopeId) => host.admin.getScopeRecord(staff, t, id);
    expect((await rec(A, s.installA))?.servingRef).toBe(LISTED_REF);
    expect((await rec(B, s.installB))?.servingRef).toBe(LISTED_REF);
    // The fork is indistinguishable by script and version — only its lineage says copy.
    const fork = await rec(A, s.forkOfA);
    expect(fork?.servingRef).toBe(LISTED_REF);
    expect(fork?.forkedFrom).toBe(s.installA);
    // The clean-room preview inherits no serving script (#527) and has no lineage at all.
    const preview = await rec(A, s.cleanRoom);
    expect(preview?.servingRef ?? null).toBeNull();
    expect(preview?.forkedFrom).toBeNull();
    expect(preview?.kind).toBe('preview');
    await host.close();
  });

  it('before the promote, nothing of ours is behind', async () => {
    const host = hostOf();
    expect(await pass(host)).toEqual([]);
    await host.close();
  });

  it("after the promote, reconciles every install — both tenants' — and never the fork, the preview, or the private scope", async () => {
    const host = hostOf();
    // The promote's in-place serve. No install's pointer moves: they are each tenant's.
    await host.admin.setVerticalServing(staff, LISTED, { ref: LISTED_REF, versionId: v2, doClasses: ['ScopeDO'], migrationTag: 'v1' });

    expect(await pass(host)).toEqual([s.installA, s.installB].sort());

    for (const [t, id] of [[A, s.installA], [B, s.installB]] as const) {
      const r = await host.admin.getScopeRecord(staff, t, id);
      expect(r?.provisionedVersionId).toBe(v2); // what the hook ran as
      expect(r?.verticalVersionId).toBe(v1); // the tenant's pointer, untouched
    }
    // The fork's receipt is where it was: nothing ran on the copy.
    expect((await host.admin.getScopeRecord(staff, A, s.forkOfA))?.provisionedVersionId).toBe(v1);
    expect((await host.admin.getScopeRecord(staff, A, s.cleanRoom))?.provisionedVersionId).toBeNull();

    // Idempotent: the receipts now match what runs, so the next pass reaches none of ours.
    expect(await pass(host)).toEqual([]);
    await host.close();
  });
});

/**
 * The sweep counts a vertical that implements no reconcile as `unsupported`, apart from its
 * failures (#1653). The mapping is decided here, on the vertical's real answer as the
 * platform's own client reads it — the two 501s a vertical can give today are the routes
 * `mountPlatformSurface` answers without an owner-of-record, and a hand-mounted surface's
 * `/internal/*` catch-all (auth-server's).
 */
describe('reconcileOrUnsupported (#1653)', () => {
  const T = tenantId.parse(ulid());
  const S = scopeId.parse(ulid());
  const clientAnswering = (res: () => Response | Promise<Response>) =>
    new VerticalClient({ fetch: (async () => res()) as unknown as typeof fetch, platformSecret: 'x' });
  const call = (client: VerticalClient) => () =>
    client.reconcileInstance({ tenantId: T, scopeId: S } as Parameters<VerticalClient['reconcileInstance']>[0]);
  const answer = (status: number, error: string) => () =>
    new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } });

  it('is unsupported for either 501 a vertical gives today', async () => {
    await expect(
      reconcileOrUnsupported(call(clientAnswering(answer(501, 'this vertical keeps no owner-of-record to reconcile from')))),
    ).resolves.toBe('unsupported');
    await expect(
      reconcileOrUnsupported(call(clientAnswering(answer(501, 'auth-server does not implement POST /internal/reconcile')))),
    ).resolves.toBe('unsupported');
  });

  it('is a success for a 2xx, and still a failure for every other refusal', async () => {
    const ok = () =>
      new Response(JSON.stringify({ tenantId: T, scopeId: S, owner: principalId.parse(ulid()) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    await expect(reconcileOrUnsupported(call(clientAnswering(ok)))).resolves.toBeUndefined();
    for (const [status, error] of [
      [409, 'no owner of record for scope — cannot reconcile; re-run the full install'],
      [500, 'the vertical broke'],
      [403, 'platform secret mismatch'],
    ] as const) {
      const refused = reconcileOrUnsupported(call(clientAnswering(answer(status, error))));
      await expect(refused).rejects.toBeInstanceOf(ControlPlaneError);
      await expect(refused).rejects.toMatchObject({ status });
    }
    // A transport failure is not the vertical's answer at all.
    const unreachable = new VerticalClient({
      fetch: (async () => {
        throw new Error('Worker not found.');
      }) as unknown as typeof fetch,
      platformSecret: 'x',
    });
    await expect(reconcileOrUnsupported(call(unreachable))).rejects.toMatchObject({ status: 502 });
  });
});

/**
 * The sweep records the version it asked for (`expected`) when a reconcile resolves, so the
 * deployment the scope's ladder reached must run exactly that (#1661 review). A serving ref
 * that did not resolve falls back to the bound version's deployment; reconciling there and
 * recording the served version would mark the scope repaired while the served version's
 * hook never ran. The guard refuses before the call, so the sweep counts it `failed`,
 * records nothing, and asks again next pass.
 */
describe('assertReconcileReaches (#1653)', () => {
  const S = scopeId.parse(ulid());

  it('lets a reconcile through when the reached deployment runs the expected version', () => {
    expect(() => assertReconcileReaches(S, 'v2', 'v2')).not.toThrow();
  });

  it('refuses one whose deployment runs another version, or one the platform cannot name', () => {
    expect(() => assertReconcileReaches(S, 'v2', 'v1')).toThrow(/runs v2, but the deployment it resolved to runs v1/);
    expect(() => assertReconcileReaches(S, 'v2', null)).toThrow(/cannot name/);
  });
});

describe('PROVISION_RECONCILE_BATCH (#1653)', () => {
  it('is a non-negative integer or the default — 0 is the pause, and a typo is neither extreme', () => {
    expect(parseReconcileBatch(undefined)).toBeUndefined();
    expect(parseReconcileBatch('')).toBeUndefined();
    expect(parseReconcileBatch('200')).toBe(200);
    expect(parseReconcileBatch('0')).toBe(0);
    expect(parseReconcileBatch('-1')).toBeUndefined();
    expect(parseReconcileBatch('2.5')).toBeUndefined();
    expect(parseReconcileBatch('lots')).toBeUndefined();
  });
});

/**
 * #1674 — every hosted path that runs a vertical's provision or reconcile puts the
 * directory's recorded OFF back afterwards, against the REAL directory DO.
 *
 * The fake deployment is the part a hosted scope's own store plays. A wipe loses the OFF
 * marker; the deployment's seat then makes a wiped store `on` (a missing grant is created,
 * #1659) and leaves a live `off` alone (the seat checks the marker). The control plane's own
 * `provisionScope` never re-asserts a delegated scope, so a path that forgets the re-assert
 * after the deployment's seat leaves the module on — and each path has its own test here,
 * so a refactor that bypasses the shared helper at one site goes red at that site.
 */
describe('hosted provision and reconcile paths re-assert the schedule switch (#1674)', () => {
  const staff = platformActorId.parse(ulid());
  const suffix = ulid().toLowerCase().slice(-10);
  const VERT = `switch-${suffix}`;
  const MANAGER = `manager-${suffix}`;
  const MODULE = '@test/hosted-tick';
  type Position = 'on' | 'off' | 'wiped';
  const store = new Map<string, Position>();
  /** Scopes whose deployment refuses the switch — a far end that cannot be reached. */
  const unreachable = new Set<string>();

  const seat = (s: string) => {
    const at = store.get(s);
    if (at === undefined || at === 'wiped') store.set(s, 'on');
  };
  const deployment = {
    provisionInstance: async (input: { tenantId: string; scopeId: string; owner: string }) => {
      seat(input.scopeId);
      return { tenantId: input.tenantId, scopeId: input.scopeId, owner: input.owner };
    },
    reconcileInstance: async (input: { tenantId: string; scopeId: string }) => {
      seat(input.scopeId);
      return { tenantId: input.tenantId, scopeId: input.scopeId, owner: ulid() };
    },
    configureInstance: async () => undefined,
    // A rewind to a bookmark taken before the switch was pulled: the grants come back live
    // and the marker is gone — what a PITR restore of the scope's storage leaves behind.
    rewindScope: async (s: string, bookmark: string) => {
      store.set(s, 'on');
      return { rewindingTo: bookmark };
    },
  } as unknown as VerticalClient;

  const hostOf = () =>
    new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      systemSwitchDelegation: {
        switch: async ({ scopeId: s, to }) => {
          if (unreachable.has(s)) throw new Error('vertical unreachable during system-switch');
          const at = store.get(s);
          if (at === undefined || at === 'wiped') return { held: false, changed: false, permissions: [] };
          store.set(s, to);
          return { held: true, changed: at !== to, permissions: [] };
        },
        status: async ({ scopeId: s }) => {
          const at = store.get(s);
          return at === undefined || at === 'wiped' ? [] : [{ moduleId: MODULE as never, schedules: at }];
        },
      },
    });
  const deps = (host: CloudflareScopeHost) => ({ host, actor: staff, resolveVerticalForScope: async () => deployment });

  let host: CloudflareScopeHost;
  const t = tenantId.parse(ulid());
  const managerTenant = tenantId.parse(ulid());
  const managerScope = scopeId.parse(ulid());
  const owner = principalId.parse(ulid());

  /** A hosted scope the deployment has provisioned, optionally switched off, then wiped. */
  const wipedScope = async (tenant: TenantId, switchedOff: boolean, id = scopeId.parse(ulid())) => {
    await host.provisionScope(staff, { tenantId: tenant, scopeId: id, vertical: VERT });
    await host.admin.activateScope(staff, tenant, id);
    seat(id);
    if (switchedOff) {
      await host.admin.revokeFromSystem(staff, {
        moduleId: MODULE as never,
        node: { tenantId: tenant, scopeId: id },
        reason: 'incident',
      });
    }
    store.set(id, 'wiped');
    return id;
  };

  beforeAll(async () => {
    await warmControlPlane(env.CONTROL_PLANE);
    host = hostOf();
    await host.admin.createTenant(staff, { id: t, slug: `sw-${suffix}`, name: 'Switch' });
    await host.admin.registerVertical(staff, { slug: MANAGER, name: 'Manager', source: 'builtin', entitlements: ['tick'] });
    await host.admin.setVerticalTenantProvisioner(staff, MANAGER, true);
    await host.admin.createTenant(staff, { id: managerTenant, slug: `mgr-${suffix}`, name: 'Manager' });
    await host.provisionScope(staff, { tenantId: managerTenant, scopeId: managerScope, vertical: MANAGER });
    await host.admin.activateScope(staff, managerTenant, managerScope);
  });

  describe('the sweep reconcile (`reconcileReachedScope`)', () => {
    const payload = { entitlements: [], identityLinks: [], connectionGrants: [], connectionKeys: [] };
    it('a switched-off scope whose storage was wiped comes back OFF', async () => {
      const s = await wipedScope(t, true);
      await reconcileReachedScope(host.admin, { tenantId: t, scopeId: s }, deployment, payload);
      expect(store.get(s)).toBe('off');
    });
    it('twin: with no record, the scope comes back on', async () => {
      const s = await wipedScope(t, false);
      await reconcileReachedScope(host.admin, { tenantId: t, scopeId: s }, deployment, payload);
      expect(store.get(s)).toBe('on');
    });
  });

  describe('the set-entitlements drain (a reconcile)', () => {
    const drain = (s: ScopeId) =>
      setEntitlementsHandler(deps(host))(
        { tenantId: managerTenant, scopeId: managerScope, vertical: MANAGER },
        drainIntent('set-entitlements', { tenantId: t, authScopeId: s, plan: 'pro', entitlements: [{ key: 'tick', plan: 'pro' }] }),
      );
    it('a switched-off scope whose storage was wiped comes back OFF', async () => {
      const s = await wipedScope(t, true);
      expect((await drain(s)).status).toBe('done');
      expect(store.get(s)).toBe('off');
    });
    it('twin: with no record, the scope comes back on', async () => {
      const s = await wipedScope(t, false);
      expect((await drain(s)).status).toBe('done');
      expect(store.get(s)).toBe('on');
    });
  });

  describe('the provision-sibling drain, re-drained onto the sibling an earlier pass minted', () => {
    const parent = scopeId.parse(ulid());
    beforeAll(async () => {
      await host.provisionScope(staff, { tenantId: t, scopeId: parent, vertical: VERT });
      await host.admin.activateScope(staff, t, parent);
    });
    const drain = (sibling: ScopeId) =>
      provisionSiblingHandler(deps(host))(
        { tenantId: t, scopeId: parent, vertical: VERT },
        drainIntent('provision-sibling', { slug: `sib-${sibling.slice(-8).toLowerCase()}`, name: 'Sibling', owner }, { scopeId: sibling }),
      );
    it('a switched-off sibling whose storage was wiped comes back OFF', async () => {
      const s = await wipedScope(t, true);
      expect((await drain(s)).status).toBe('done');
      expect(store.get(s)).toBe('off');
    });
    it('twin: with no record, the sibling comes back on', async () => {
      const s = await wipedScope(t, false);
      expect((await drain(s)).status).toBe('done');
      expect(store.get(s)).toBe('on');
    });
  });

  describe('a PITR rewind (the route a tenant owner can reach)', () => {
    let running: string;
    const payload = { entitlements: [], identityLinks: [], connectionGrants: [], connectionKeys: [] };
    beforeAll(async () => {
      await host.admin.registerVertical(staff, { slug: VERT, name: 'Switch', source: 'cli', ownerTenant: t });
      running = ulid();
      await host.admin.publishVersion(staff, {
        id: running,
        verticalSlug: VERT,
        version: '1.0.0',
        manifestDigest: 'm',
        permissionDigest: 'p',
        migrationDigest: 'g',
        deploymentRef: `${VERT}-1-0-0`,
      });
      await host.admin.admitVersion(staff, running).catch(() => undefined);
    });
    const rewound = async (switchedOff: boolean) => {
      const s = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: VERT });
      await host.admin.activateScope(staff, t, s);
      await host.admin.bindScopeVersion(staff, t, s, running);
      await host.admin.markScopeProvisioned(staff, t, s, running);
      seat(s);
      if (switchedOff) {
        await host.admin.revokeFromSystem(staff, { moduleId: MODULE as never, node: { tenantId: t, scopeId: s }, reason: 'incident' });
      }
      const app = createControlPlaneApi({
        host,
        authenticate: UNSAFE_devPlatformActorAuth(),
        verticals: { [VERT]: deployment },
      });
      const res = await app.request(`/tenants/${t}/scopes/${s}/rewind`, {
        method: 'POST',
        headers: { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' },
        body: JSON.stringify({ bookmark: 'before-the-incident' }),
      });
      expect(res.status).toBe(200);
      return s;
    };
    const sweepOnly = (s: ScopeId) =>
      runPlatformSweep(host, {
        actor: staff,
        fetch: (() => Promise.reject(new Error('unused'))) as never,
        sweepers: {},
        drainRetries: false,
        runSchedules: false,
        reconcileMigrations: false,
        gcSnapshots: false,
        provisionReconcileBatch: 10_000,
        reconcileScopeFn: async (tenant, id) =>
          id === s ? reconcileReachedScope(host.admin, { tenantId: tenant, scopeId: id }, deployment, payload) : 'unsupported',
      });

    it('a rewind that drops the OFF marker is switched off again by the next sweep', async () => {
      const s = await rewound(true);
      expect(store.get(s)).toBe('on'); // the rewind itself lost the switch
      await sweepOnly(s);
      expect(store.get(s)).toBe('off');
    });

    it('a re-assert that cannot reach the deployment fails the scope: no receipt, so the next pass retries', async () => {
      const s = await rewound(true);
      unreachable.add(s);
      const report = await sweepOnly(s);
      expect(report.errors.filter((e) => e.id === s).map((e) => e.kind)).toEqual(['provision-reconcile']);
      expect((await host.admin.getScopeRecord(staff, t, s))?.provisionedVersionId).toBeNull();
      // The twin, on the same scope: once the deployment answers, the pass re-asserts and
      // writes the receipt it withheld.
      unreachable.delete(s);
      await sweepOnly(s);
      expect(store.get(s)).toBe('off');
      expect((await host.admin.getScopeRecord(staff, t, s))?.provisionedVersionId).toBe(running);
    });

    it('twin: with no record, the rewound scope stays on through the sweep', async () => {
      const s = await rewound(false);
      await sweepOnly(s);
      expect(store.get(s)).toBe('on');
    });
  });

  describe('adopt-serving (the scope starts routing to another store)', () => {
    const ADOPT = `adopt-${suffix}`;
    const REF = `${ADOPT}-serving`;
    const legacy: ScopeId[] = [];
    /** The serving script's copy of the data: the marker did not survive into it. */
    const serving = {
      exportScope: async (s: string) => ({ tenantId: t, scopeId: s, capturedAt: new Date().toISOString(), tables: [] }),
      restoreScope: async (_t: string, s: string) => {
        store.set(s, 'on');
        return { tables: 0 };
      },
    } as unknown as VerticalClient;
    const app = () =>
      createControlPlaneApi({
        host,
        authenticate: UNSAFE_devPlatformActorAuth(),
        verticals: { [ADOPT]: serving },
        resolveVerticalRef: async (ref) => (ref === REF ? serving : undefined),
      });
    beforeAll(async () => {
      await host.admin.registerVertical(staff, { slug: ADOPT, name: 'Adopt', source: 'cli', ownerTenant: t });
      // Two scopes born BEFORE the vertical serves in place: legacy, on per-version dispatch.
      for (const switchedOff of [true, false]) {
        const s = scopeId.parse(ulid());
        await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: ADOPT });
        await host.admin.activateScope(staff, t, s);
        seat(s);
        if (switchedOff) {
          await host.admin.revokeFromSystem(staff, { moduleId: MODULE as never, node: { tenantId: t, scopeId: s }, reason: 'incident' });
        }
        legacy.push(s);
      }
      const v = ulid();
      await host.admin.publishVersion(staff, {
        id: v,
        verticalSlug: ADOPT,
        version: '1.0.0',
        manifestDigest: 'm',
        permissionDigest: 'p',
        migrationDigest: 'g',
        deploymentRef: `${ADOPT}-1-0-0`,
      });
      await host.admin.admitVersion(staff, v).catch(() => undefined);
      await host.admin.setVerticalServing(staff, ADOPT, { ref: REF, versionId: v, doClasses: ['ScopeDO'], migrationTag: 'v1' });
    });
    const adopt = async (s: ScopeId) => {
      const res = await app().request(`/tenants/${t}/scopes/${s}/adopt-serving`, {
        method: 'POST',
        headers: { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' },
      });
      expect(res.status).toBe(200);
    };

    it('a switched-off scope adopted onto a store that lost the marker comes back OFF', async () => {
      await adopt(legacy[0]!);
      expect(store.get(legacy[0]!)).toBe('off');
    });

    it('twin: with no record, the adopted scope stays on', async () => {
      await adopt(legacy[1]!);
      expect(store.get(legacy[1]!)).toBe('on');
    });
  });

  describe('the provision-tenant drain, re-drained with the same proposed ids', () => {
    const drain = (tenant: TenantId, s: ScopeId) =>
      provisionTenantHandler(deps(host))(
        { tenantId: managerTenant, scopeId: managerScope, vertical: MANAGER },
        drainIntent('provision-tenant', {
          tenant: { id: tenant, slug: `cust-${tenant.slice(-10).toLowerCase()}`, name: 'Customer' },
          instance: { vertical: VERT, scopeId: s, slug: 'main', name: 'Main', owner },
          entitlements: [{ key: 'tick', plan: 'pro' }],
        }),
      );
    const customer = async (switchedOff: boolean) => {
      const tenant = tenantId.parse(ulid());
      const s = scopeId.parse(ulid());
      expect((await drain(tenant, s)).status).toBe('done');
      await wipedScope(tenant, switchedOff, s);
      return { tenant, s };
    };
    it('a switched-off customer scope whose storage was wiped comes back OFF', async () => {
      const { tenant, s } = await customer(true);
      expect((await drain(tenant, s)).status).toBe('done');
      expect(store.get(s)).toBe('off');
    });
    it('twin: with no record, the customer scope comes back on', async () => {
      const { tenant, s } = await customer(false);
      expect((await drain(tenant, s)).status).toBe('done');
      expect(store.get(s)).toBe('on');
    });
  });
});

/** A minimal intent row for a drain handler, as the dispatcher hands it over. */
function drainIntent(kind: string, payload: unknown, result: unknown = null): PlatformRequest {
  return {
    id: platformRequestId.parse(ulid()),
    kind,
    payload,
    requestedBy: principalId.parse(ulid()),
    impersonation: null,
    status: 'pending',
    attempts: 0,
    lastError: null,
    failure: null,
    result,
    requestedAt: new Date().toISOString() as PlatformRequest['requestedAt'],
    settledAt: null,
  };
}
