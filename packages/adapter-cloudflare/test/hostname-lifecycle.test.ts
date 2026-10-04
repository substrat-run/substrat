import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { errorCodeOf, permissionKey, platformActorId, principalId, scopeId, tenantId, type ScopeId, type ScopeLifecycle, type TenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { CloudflareScopeHost, LIFECYCLE_EPOCH_SKEW_MS, TENANT_UNRECORDED_PER_PASS, type LifecycleDelegation } from '../src/host.js';
import { createRouteResolver } from '../src/route-resolver.js';
import router, { type Env } from '../../../apps/router/src/worker.js';
import { warmControlPlane } from './do-warmup.js';

beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

it('gates real directory resolution and router dispatch on lifecycle, restoring without rebind (#1713)', async () => {
  const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
  const actor = platformActorId.parse(ulid());
  const principal = principalId.parse(ulid());
  const tenant = tenantId.parse(ulid());
  const scope = scopeId.parse(ulid());
  const hostname = `lifecycle-${scope.toLowerCase()}.example.com`;
  await host.admin.createTenant(actor, { id: tenant, slug: `route-${tenant.toLowerCase()}`, name: 'Routing' });
  await host.provisionScope(actor, { tenantId: tenant, scopeId: scope, vertical: 'todo' });
  await host.admin.bindHostname(actor, {
    hostname, tenantId: tenant, scopeId: scope, surface: 'app', region: null, canonical: true,
  });
  await host.admin.setHostnameStatus(actor, hostname, 'active');
  const original = await host.admin.listHostnames(actor, { scopeId: scope });
  const resolve = createRouteResolver(env.CONTROL_PLANE);
  const fetch = vi.fn(async () => new Response('served'));
  const dispatch = vi.fn();
  const routerEnv = {
    CONTROL_PLANE: env.CONTROL_PLANE, ROUTER_SECRET: 'test-secret',
    VERTICAL_TODO: { fetch }, DISPATCH: { get: dispatch },
  } as unknown as Env;
  const request = () => router.fetch(new Request(`https://${hostname}/`), routerEnv);
  const unknown = await router.fetch(new Request('https://unknown.example.com/'), routerEnv);
  const neutralBody = await unknown.text();
  const refused = async () => {
    fetch.mockClear();
    dispatch.mockClear();
    expect(await resolve(hostname)).toBeUndefined();
    const response = await request();
    expect(response.status).toBe(404);
    expect(await response.text()).toBe(neutralBody);
    expect(fetch).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(await host.admin.listHostnames(actor, { scopeId: scope })).toEqual(original);
    await expect(host.getScope(principal, tenant, scope)).rejects.toThrow(/not active/);
  };
  const served = async () => {
    expect(await resolve(hostname)).toMatchObject({ tenantId: tenant, scopeId: scope, deploymentRef: null });
    expect(await (await request()).text()).toBe('served');
    expect(fetch).toHaveBeenCalled();
    await expect(host.getScope(principal, tenant, scope)).resolves.toBeDefined();
  };
  await refused(); // provisioning
  await host.admin.activateScope(actor, tenant, scope);
  await served();
  await host.admin.suspendScope(actor, tenant, scope);
  await refused();
  await host.admin.unsuspendScope(actor, tenant, scope);
  await served();
  await host.admin.setTenantStatus(actor, tenant, 'suspended');
  await refused();
  await host.admin.setTenantStatus(actor, tenant, 'active');
  await served();
  await host.admin.archiveScope(actor, tenant, scope);
  await refused();
});

/**
 * #1713's delivery half, against the real directory DO: a transition moves the directory and then
 * delivers the scope's lifecycle to the deployment serving it, here a CP-LESS host on the same
 * scope namespace, which is what holds the scope's own work. A tenant transition fans out to every
 * hosted scope under it. A delivery that does not land never refuses the lever: it is an
 * ops-failure row, and the heal sweep delivers again until a receipt matches the directory.
 */
describe('the platform delivers a scope lifecycle to the deployment serving it (#1713)', () => {
  const actor = platformActorId.parse(ulid());
  const owner = principalId.parse(ulid());
  const deliveries: { scopeId: string; scope: string; tenant: string; lifecycle: ScopeLifecycle }[] = [];
  let failing = false;
  const deployment = () => new CloudflareScopeHost({ scope: env.SCOPE });
  const lifecycleDelegation: LifecycleDelegation = {
    deliver: async ({ scopeId: s, lifecycle }) => {
      if (failing) throw new Error('deployment unreachable');
      deliveries.push({ scopeId: s, scope: lifecycle.scope, tenant: lifecycle.tenant, lifecycle });
      return deployment().setLifecycleLocal(s, lifecycle);
    },
  };
  // A directory of this suite's own (#1899's pattern): the host addresses 'control-plane', and
  // this resolves it to a fresh directory object, so the restore cases below replace nothing
  // another suite reads, and the epoch starts at 0 whatever ran before.
  let directoryName = `lifecycle-delivery-${ulid()}`;
  const directory = {
    idFromName: () => env.CONTROL_PLANE.idFromName(directoryName),
    get: (id: DurableObjectId) => env.CONTROL_PLANE.get(id),
  } as unknown as DurableObjectNamespace;
  const platform = () => new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: directory, lifecycleDelegation });
  beforeAll(() => warmControlPlane(directory));
  const USE = permissionKey.parse('perm:use');

  const activations = new Map<ScopeId, string[]>();
  const deliveredTo = (s: ScopeId) => deliveries.filter((d) => d.scopeId === s).map((d) => `${d.scope}/${d.tenant}`);
  const tenantOf = async () => {
    const t = tenantId.parse(ulid());
    await platform().admin.createTenant(actor, { id: t, slug: `life-${t.toLowerCase()}`, name: 'Lifecycle' });
    return t;
  };
  const hosted = async (t: TenantId, vertical: string | null = 'todo') => {
    const s = scopeId.parse(ulid());
    await platform().provisionScope(actor, { tenantId: t, scopeId: s, ...(vertical ? { vertical } : {}) });
    await platform().admin.activateScope(actor, t, s);
    await deployment().provisionScopeLocal({
      tenantId: t,
      scopeId: s,
      owner,
      roles: [{ key: 'office-admin', permissions: [USE], source: 'vertical' }],
      ownerRoleKey: 'office-admin',
    });
    // Activation is a transition too. Counted from here, whatever it delivered: before any
    // restore it delivers nothing (the first test pins that), after one it delivers once.
    activations.set(s, deliveredTo(s));
    deliveries.splice(0, deliveries.length, ...deliveries.filter((d) => d.scopeId !== s));
    return s;
  };
  const servedHere = (t: TenantId, s: ScopeId) => deployment().getScope(owner, t, s);

  it('a suspend reaches the deployment, which then refuses in the directory\'s words; unsuspend lifts it', async () => {
    const t = await tenantOf();
    const s = await hosted(t);
    // A directory never restored: the activation of a live scope posts nothing, so a deployment
    // built before the route logs nothing for it.
    expect(activations.get(s)).toEqual([]);
    await platform().admin.suspendScope(actor, t, s);
    expect(deliveredTo(s)).toEqual(['suspended/active']);
    await expect(servedHere(t, s)).rejects.toThrow(`scope not active (status: suspended): ${s}`);
    await platform().admin.unsuspendScope(actor, t, s);
    expect(deliveredTo(s)).toEqual(['suspended/active', 'active/active']);
    await expect(servedHere(t, s)).resolves.toBeDefined();
    // Converged: the receipt matches the directory, so the heal sweep has nothing for it.
    await platform().healLifecycles(actor, { limit: 1000 });
    expect(deliveredTo(s)).toEqual(['suspended/active', 'active/active']);
  });

  it('the receipt is what stops a re-delivery: an archived scope, delivered once, is not delivered again', async () => {
    const t = await tenantOf();
    const s = await hosted(t);
    await platform().admin.archiveScope(actor, t, s);
    expect(deliveredTo(s)).toEqual(['archived/active']);
    await platform().healLifecycles(actor, { limit: 1000 });
    await platform().healLifecycles(actor, { limit: 1000 });
    expect(deliveredTo(s)).toEqual(['archived/active']);
    await expect(servedHere(t, s)).rejects.toThrow(/scope not active \(status: archived\)/);
  });

  it("a tenant's transition fans out to every hosted scope under it, and to nothing else", async () => {
    const t = await tenantOf();
    const a = await hosted(t);
    const b = await hosted(t);
    const bare = await hosted(t, null); // no vertical: no deployment serves it
    const other = await hosted(await tenantOf());
    await platform().admin.setTenantStatus(actor, t, 'suspended');
    expect(deliveredTo(a)).toEqual(['active/suspended']);
    expect(deliveredTo(b)).toEqual(['active/suspended']);
    expect(deliveredTo(bare)).toEqual([]);
    expect(deliveredTo(other)).toEqual([]);
    await expect(servedHere(t, a)).rejects.toThrow(`tenant not active (status: suspended): ${t}`);
    await expect(servedHere(t, b)).rejects.toThrow(/tenant not active/);
    await platform().admin.setTenantStatus(actor, t, 'active');
    expect(deliveredTo(a)).toEqual(['active/suspended', 'active/active']);
    await expect(servedHere(t, b)).resolves.toBeDefined();
  });

  it('a delivery that does not land never refuses the lever: an ops-failure row, then the heal sweep delivers', async () => {
    const t = await tenantOf();
    const s = await hosted(t);
    failing = true;
    try {
      await platform().admin.suspendScope(actor, t, s); // resolves: the directory moved
    } finally {
      failing = false;
    }
    expect((await platform().admin.getScopeRecord(actor, t, s))?.status).toBe('suspended');
    const failures = await platform().admin.listOpsFailures(actor, { scopeId: s });
    expect(failures.map((f) => [f.operation, f.stage])).toEqual([['scope.lifecycle', 'deliver']]);
    // The gap the sweep exists for: the deployment still runs the scope.
    await expect(servedHere(t, s)).resolves.toBeDefined();

    const healed = await platform().healLifecycles(actor, { limit: 1000 });
    expect(healed.failed).toBe(0);
    expect(deliveredTo(s)).toEqual(['suspended/active']);
    await expect(servedHere(t, s)).rejects.toThrow(/scope not active \(status: suspended\)/);

    // A held scope is delivered again on every pass: what puts a hold back on a store a carry or
    // a restore landed without it.
    await platform().healLifecycles(actor, { limit: 1000 });
    expect(deliveredTo(s)).toEqual(['suspended/active', 'suspended/active']);
  });

  it('every transition delivers a strictly newer revision, counted in the directory', async () => {
    const t = await tenantOf();
    const s = await hosted(t);
    await platform().admin.suspendScope(actor, t, s);
    await platform().admin.setTenantStatus(actor, t, 'suspended');
    await platform().admin.unsuspendScope(actor, t, s);
    await platform().admin.setTenantStatus(actor, t, 'active');
    const revs = deliveries.filter((d) => d.scopeId === s).map((d) => d.lifecycle.revision);
    // activate made the scope revision 1; each change after it moves exactly its own counter
    expect(revs).toEqual([
      { epoch: 0, scope: 2, tenant: 0 },
      { epoch: 0, scope: 2, tenant: 1 },
      { epoch: 0, scope: 3, tenant: 1 },
      { epoch: 0, scope: 3, tenant: 2 },
    ]);
  });

  it("Codex's repro end to end: the suspend's delivery replayed after the unsuspend's is refused", async () => {
    const t = await tenantOf();
    const s = await hosted(t);
    await platform().admin.suspendScope(actor, t, s);
    const suspendDelivery = deliveries.filter((d) => d.scopeId === s).at(-1)!.lifecycle;
    await platform().admin.unsuspendScope(actor, t, s);
    // The overlapping push the review reproduced: the older one lands last.
    expect((await deployment().setLifecycleLocal(s, suspendDelivery)).applied).toBe(false);
    await expect(servedHere(t, s)).resolves.toBeDefined();
    // Converged: nothing for the heal sweep to redo.
    const before = deliveredTo(s).length;
    await platform().healLifecycles(actor, { limit: 1000 });
    expect(deliveredTo(s)).toHaveLength(before);
  });

  it('interleaved tenant and scope changes replayed in reverse settle on the latest', async () => {
    const t = await tenantOf();
    const s = await hosted(t);
    await platform().admin.setTenantStatus(actor, t, 'suspended');
    await platform().admin.suspendScope(actor, t, s);
    await platform().admin.setTenantStatus(actor, t, 'active');
    const sent = deliveries.filter((d) => d.scopeId === s).map((d) => d.lifecycle);
    for (const late of [...sent].reverse().slice(1)) {
      expect((await deployment().setLifecycleLocal(s, late)).applied).toBe(false);
    }
    // held by the scope's own suspension, not the lifted tenant's
    await expect(servedHere(t, s)).rejects.toThrow(`scope not active (status: suspended): ${s}`);
    await platform().admin.unsuspendScope(actor, t, s);
    await expect(servedHere(t, s)).resolves.toBeDefined();
  });

  /**
   * A directory restore (`restoreDirectory` → `importDump`) rolls the directory's lifecycle
   * counters back with everything else. Each restore mints a newer epoch, so the restored
   * directory's deliveries outrank whatever the replaced history delivered, and the heal pass
   * re-converges every hosted scope on what the directory now says — in BOTH directions.
   */
  describe('after a directory restore, the heal converges on the restored directory', () => {
    const restoreTo = async (dump: Awaited<ReturnType<ReturnType<typeof platform>['admin']['exportDirectory']>>) => {
      await platform().admin.restoreDirectory(actor, dump);
      await platform().healLifecycles(actor, { limit: 1000 });
    };

    it('a scope live in its deployment, restored to a directory that says suspended, is held', async () => {
      const t = await tenantOf();
      const s = await hosted(t);
      await platform().admin.suspendScope(actor, t, s);
      const suspendedCopy = await platform().admin.exportDirectory(actor);
      await platform().admin.unsuspendScope(actor, t, s); // the deployment now holds active, at a HIGHER counter
      await expect(servedHere(t, s)).resolves.toBeDefined();
      await restoreTo(suspendedCopy);
      await expect(servedHere(t, s)).rejects.toThrow(`scope not active (status: suspended): ${s}`);
      expect(deliveredTo(s).at(-1)).toBe('suspended/active');
    });

    it('a scope held in its deployment, restored to a directory that says active, runs again', async () => {
      const t = await tenantOf();
      const s = await hosted(t);
      const liveCopy = await platform().admin.exportDirectory(actor);
      await platform().admin.suspendScope(actor, t, s);
      await expect(servedHere(t, s)).rejects.toThrow(/not active/);
      await restoreTo(liveCopy);
      await expect(servedHere(t, s)).resolves.toBeDefined();
    });

    it('a scope with NO receipt in the restored copy (activated silently, before any restore) still converges', async () => {
      // A directory never restored, so the activation posts nothing and leaves no receipt.
      const kept = directoryName;
      directoryName = `lifecycle-fresh-${ulid()}`;
      try {
        await warmControlPlane(directory);
        const t = await tenantOf();
        const s = await hosted(t);
        expect(activations.get(s)).toEqual([]);
        const copy = await platform().admin.exportDirectory(actor); // no receipt row for s
        await platform().admin.suspendScope(actor, t, s);
        await expect(servedHere(t, s)).rejects.toThrow(/not active/);
        await restoreTo(copy);
        // the copy says active and holds no receipt: after a restore, that is drift
        await expect(servedHere(t, s)).resolves.toBeDefined();
      } finally {
        directoryName = kept;
      }
    });

    it('a restore that leaves the statuses as they were still re-converges, so later transitions land', async () => {
      const t = await tenantOf();
      const s = await hosted(t);
      const copy = await platform().admin.exportDirectory(actor); // active, low counters
      await platform().admin.suspendScope(actor, t, s);
      await platform().admin.unsuspendScope(actor, t, s); // active again, higher counters
      await restoreTo(copy);
      const healed = deliveries.filter((d) => d.scopeId === s).at(-1)!.lifecycle;
      expect(healed.scope).toBe('active');
      expect(healed.revision.epoch).toBeGreaterThan(0);
      // The suspend after the restore carries a LOWER scope counter than the deployment saw
      // before it; the newer epoch is what lets it land.
      await platform().admin.suspendScope(actor, t, s);
      await expect(servedHere(t, s)).rejects.toThrow(`scope not active (status: suspended): ${s}`);
    });

    /**
     * Codex round 2: a restore onto a FRESH directory object has only the clock as its floor, and
     * the epoch a scope already holds may be ahead of it (the old directory ran on a fast clock, or
     * restored in the same millisecond). The scope refuses the new directory as older; the
     * directory then learns past the held epoch and delivers again, so it converges anyway.
     */
    describe('a fresh-directory restore behind an epoch the scope already holds', () => {
      /** Restore `copy` onto a brand-new directory object, run `between`, then heal; restores the suite's directory after. */
      const ontoFresh = async (copy: Parameters<typeof restoreTo>[0], between: () => Promise<void> = async () => {}) => {
        const kept = directoryName;
        directoryName = `lifecycle-fresh-${ulid()}`;
        await warmControlPlane(directory);
        await platform().admin.restoreDirectory(actor, copy);
        await between();
        await platform().healLifecycles(actor, { limit: 1000 });
        return () => {
          directoryName = kept;
        };
      };
      const farAhead = (state: { scope: 'active' | 'suspended' }, epoch: number) => ({
        scope: state.scope,
        tenant: 'active' as const,
        at: '2026-10-01T00:00:00.000Z' as ScopeLifecycle['at'],
        revision: { epoch, scope: 50, tenant: 50 },
      });

      it('the directory says suspended: the hold reaches a scope holding a higher epoch as active', async () => {
        const t = await tenantOf();
        const s = await hosted(t);
        await platform().admin.suspendScope(actor, t, s);
        const copy = await platform().admin.exportDirectory(actor);
        // The old history delivered active at an epoch a backward clock will not reach.
        await deployment().setLifecycleLocal(s, farAhead({ scope: 'active' }, Date.now() + 60 * 60 * 1000));
        await expect(servedHere(t, s)).resolves.toBeDefined();
        const back = await ontoFresh(copy);
        try {
          await expect(servedHere(t, s)).rejects.toThrow(`scope not active (status: suspended): ${s}`);
        } finally {
          back();
        }
      });

      it('the directory says active: the lift reaches a scope holding a higher epoch as suspended', async () => {
        const t = await tenantOf();
        const s = await hosted(t);
        const copy = await platform().admin.exportDirectory(actor);
        await deployment().setLifecycleLocal(s, farAhead({ scope: 'suspended' }, Date.now() + 60 * 60 * 1000));
        await expect(servedHere(t, s)).rejects.toThrow(/not active/);
        const back = await ontoFresh(copy);
        try {
          await expect(servedHere(t, s)).resolves.toBeDefined();
        } finally {
          back();
        }
      });

      it('two restores in the same millisecond: an EQUAL epoch with other counters converges too', async () => {
        const t = await tenantOf();
        const s = await hosted(t);
        await platform().admin.suspendScope(actor, t, s);
        const copy = await platform().admin.exportDirectory(actor);
        const back = await ontoFresh(copy, async () => {
          // the other history minted the very same epoch and delivered active at higher counters
          const [row] = (await (env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName(directoryName)) as unknown as {
            lifecycleTargets(f: object): Promise<{ epoch: number }[]>;
          }).lifecycleTargets({ scopeId: s })) as { epoch: number }[];
          await deployment().setLifecycleLocal(s, farAhead({ scope: 'active' }, row!.epoch));
        });
        try {
          await expect(servedHere(t, s)).rejects.toThrow(`scope not active (status: suspended): ${s}`);
        } finally {
          back();
        }
      });

      it('a forged epoch far past the clock is never raised to: an ops failure, the directory unmoved', async () => {
        const t = await tenantOf();
        const s = await hosted(t);
        await platform().admin.suspendScope(actor, t, s);
        const copy = await platform().admin.exportDirectory(actor);
        const forged = Number.MAX_SAFE_INTEGER - 1;
        await deployment().setLifecycleLocal(s, farAhead({ scope: 'active' }, forged));
        const back = await ontoFresh(copy);
        try {
          const dir = env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName(directoryName)) as unknown as {
            lifecycleTargets(f: object): Promise<{ epoch: number }[]>;
          };
          const [row] = await dir.lifecycleTargets({ scopeId: s });
          // No raise toward the forged value: whatever the restored copy's other scopes legitimately
          // taught this directory, its epoch stays within the skew of the clock.
          expect(row!.epoch).toBeLessThanOrEqual(Date.now() + LIFECYCLE_EPOCH_SKEW_MS);
          const failures = await platform().admin.listOpsFailures(actor, { scopeId: s });
          expect(failures.map((f) => f.stage)).toContain('foreign-epoch');
        } finally {
          back();
        }
      });

      it('a held epoch within the skew (a clock somewhat ahead) is raised past, and the scope converges', async () => {
        const t = await tenantOf();
        const s = await hosted(t);
        await platform().admin.suspendScope(actor, t, s);
        const copy = await platform().admin.exportDirectory(actor);
        const ahead = Date.now() + LIFECYCLE_EPOCH_SKEW_MS / 2;
        await deployment().setLifecycleLocal(s, farAhead({ scope: 'active' }, ahead));
        const back = await ontoFresh(copy);
        try {
          const dir = env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName(directoryName)) as unknown as {
            lifecycleTargets(f: object): Promise<{ epoch: number }[]>;
          };
          expect((await dir.lifecycleTargets({ scopeId: s }))[0]!.epoch).toBeGreaterThan(ahead);
          await expect(servedHere(t, s)).rejects.toThrow(`scope not active (status: suspended): ${s}`);
        } finally {
          back();
        }
      });

      it('a directory never restored does not raise over a foreign epoch at all', async () => {
        const kept = directoryName;
        directoryName = `lifecycle-never-${ulid()}`;
        try {
          await warmControlPlane(directory);
          const t = await tenantOf();
          const s = await hosted(t);
          await deployment().setLifecycleLocal(s, farAhead({ scope: 'active' }, 5));
          await platform().admin.suspendScope(actor, t, s); // epoch 0 delivery, refused as older
          const dir = env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName(directoryName)) as unknown as {
            lifecycleTargets(f: object): Promise<{ epoch: number }[]>;
          };
          expect((await dir.lifecycleTargets({ scopeId: s }))[0]!.epoch).toBe(0);
          expect((await platform().admin.listOpsFailures(actor, { scopeId: s })).map((f) => f.stage)).toContain('foreign-epoch');
        } finally {
          directoryName = kept;
        }
      });

      it('the raise only ever moves the epoch up, whatever order concurrent heals learn in', async () => {
        const dir = env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName(`lifecycle-raise-${ulid()}`)) as unknown as {
          raiseLifecycleEpoch(atLeast: number): Promise<number>;
        };
        expect(await dir.raiseLifecycleEpoch(10)).toBe(10);
        expect(await dir.raiseLifecycleEpoch(7)).toBe(10);
        const raced = await Promise.all([dir.raiseLifecycleEpoch(12), dir.raiseLifecycleEpoch(11), dir.raiseLifecycleEpoch(13)]);
        expect(Math.max(...raced)).toBe(13);
        expect(await dir.raiseLifecycleEpoch(0)).toBe(13);
      });
    });

    it("Codex's late pass, within one environment: a heal that read BEFORE a restore delivers after it, and the restored state wins", async () => {
      const t = await tenantOf();
      const s = await hosted(t);
      await platform().admin.suspendScope(actor, t, s);
      const copy = await platform().admin.exportDirectory(actor); // says suspended
      await platform().admin.unsuspendScope(actor, t, s);
      // The rows an in-flight heal read before the restore: they say active, at the old epoch.
      const real = env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName(directoryName)) as unknown as {
        lifecycleTargets(f: object): Promise<unknown[]>;
      };
      // Read while the unsuspend's delivery was still in flight, before its receipt landed, so the
      // late pass has something to deliver.
      const stale = ((await real.lifecycleTargets({ scopeId: s })) as Record<string, unknown>[]).map((r) => ({
        ...r,
        delivered: null,
      }));
      await restoreTo(copy); // the directory (the same object) is the restored history now: suspended
      await expect(servedHere(t, s)).rejects.toThrow(/not active/);
      // The late pass: its FIRST read is the stale one, everything after is the live store.
      let first = true;
      const lateDirectory = {
        idFromName: directory.idFromName,
        get: (id: DurableObjectId) =>
          new Proxy(env.CONTROL_PLANE.get(id) as object, {
            get: (target, prop) =>
              prop === 'lifecycleTargets' && first
                ? async () => ((first = false), stale)
                : (Reflect.get(target, prop) as unknown),
          }),
      } as unknown as DurableObjectNamespace;
      await new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: lateDirectory, lifecycleDelegation }).healLifecycles(actor, {
        limit: 1000,
      });
      // It delivered active at the old epoch, was refused, raised past what the scope holds, re-read
      // the CURRENT store and delivered that: the restored suspension stands.
      expect(first).toBe(false);
      const last = deliveries.filter((d) => d.scopeId === s).slice(-2);
      expect(last.map((d) => d.scope)).toEqual(['active', 'suspended']); // the stale try, then the live re-read
      await expect(servedHere(t, s)).rejects.toThrow(`scope not active (status: suspended): ${s}`);
      // and the restored directory's own heal finds nothing to undo
      await platform().healLifecycles(actor, { limit: 1000 });
      await expect(servedHere(t, s)).rejects.toThrow(/not active/);
    });

    it('each restore mints an epoch newer than the last, and a second heal has nothing to redo', async () => {
      const t = await tenantOf();
      const s = await hosted(t);
      await platform().admin.suspendScope(actor, t, s);
      const copy = await platform().admin.exportDirectory(actor);
      await restoreTo(copy);
      const first = deliveries.filter((d) => d.scopeId === s).at(-1)!.lifecycle.revision.epoch;
      await restoreTo(copy);
      const second = deliveries.filter((d) => d.scopeId === s).at(-1)!.lifecycle.revision.epoch;
      expect(second).toBeGreaterThan(first);
      const settled = deliveredTo(s).length;
      await platform().healLifecycles(actor, { limit: 1000 });
      // held scopes are re-delivered every pass by design; the receipt now matches, and the
      // delivery is refused as equal rather than moving anything
      expect(deliveredTo(s).length).toBe(settled + 1);
      await expect(servedHere(t, s)).rejects.toThrow(/not active/);
    });
  });

  it('the next case along: a failed UNsuspend is healed too, so a scope never stays held after the directory lifts it', async () => {
    const t = await tenantOf();
    const s = await hosted(t);
    await platform().admin.suspendScope(actor, t, s);
    failing = true;
    try {
      await platform().admin.unsuspendScope(actor, t, s);
    } finally {
      failing = false;
    }
    await expect(servedHere(t, s)).rejects.toThrow(/not active/); // fail-closed until healed
    await platform().healLifecycles(actor, { limit: 1000 });
    expect(deliveredTo(s)).toEqual(['suspended/active', 'active/active']);
    await expect(servedHere(t, s)).resolves.toBeDefined();
  });
});

/**
 * #2016's convergence, against the real directory DO: the heal asks every served scope whether it
 * holds a record of its tenant, a copy (a preview, a fork) as much as a primary — no push reconciles
 * a copy, and an active copy in a never-restored directory takes no lifecycle delivery otherwise —
 * and keeps asking until it answers that it does. The delivery carries the directory's tenant, as
 * the shared control plane's does (`lifecycleDelegationOver`).
 */
describe('the heal asks every served scope for its tenant record until it holds one (#2016)', () => {
  const actor = platformActorId.parse(ulid());
  const owner = principalId.parse(ulid());
  const USE = permissionKey.parse('perm:use');
  const asked: string[] = [];
  const deployment = () => new CloudflareScopeHost({ scope: env.SCOPE });
  const lifecycleDelegation: LifecycleDelegation = {
    deliver: async ({ tenantId: t, scopeId: s, lifecycle }) => {
      asked.push(s);
      return deployment().setLifecycleLocal(s, lifecycle, t);
    },
  };
  const directoryName = `tenant-record-${ulid()}`;
  const directory = {
    idFromName: () => env.CONTROL_PLANE.idFromName(directoryName),
    get: (id: DurableObjectId) => env.CONTROL_PLANE.get(id),
  } as unknown as DurableObjectNamespace;
  const platform = () => new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: directory, lifecycleDelegation });
  beforeAll(() => warmControlPlane(directory));

  const sql = (s: ScopeId, q: string) =>
    runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(s)), (_i, state) => state.storage.sql.exec(q).toArray());
  const receiptOf = async (s: ScopeId) =>
    ((await sql(s, `SELECT value FROM _substrat_meta WHERE key = 'provisioned_for'`))[0] as { value: string } | undefined)?.value ?? null;
  const recordedInDirectory = (s: ScopeId) =>
    runInDurableObject(env.CONTROL_PLANE.get(directory.idFromName('')), (_i, state) =>
      (state.storage.sql.exec('SELECT tenant_recorded FROM scope_lifecycle_receipts WHERE scope_id = ?', s).toArray()[0] as
        | { tenant_recorded: number | null }
        | undefined)?.tenant_recorded ?? null,
    );
  const askedFor = (s: ScopeId) => asked.filter((x) => x === s).length;

  /** A served preview fork of a live install, whose deployment storage holds data and grants but
   *  no tenant record and no role rows — what a copy loaded from a world that keeps roles elsewhere
   *  leaves, and what no push reconcile and no lifecycle transition would ever reach. */
  const unrecordedCopy = async () => {
    const t = tenantId.parse(ulid());
    await platform().admin.createTenant(actor, { id: t, slug: `rec-${t.toLowerCase()}`, name: 'Record' });
    const install = scopeId.parse(ulid());
    await platform().provisionScope(actor, { tenantId: t, scopeId: install, vertical: 'todo' });
    await platform().admin.activateScope(actor, t, install);
    const copy = scopeId.parse(ulid());
    await platform().provisionScope(actor, { tenantId: t, scopeId: copy, vertical: 'todo', kind: 'preview', forkedFrom: install });
    await platform().admin.activateScope(actor, t, copy);
    await deployment().provisionScopeLocal({
      tenantId: t,
      scopeId: copy,
      owner,
      roles: [{ key: 'office-admin', permissions: [USE], source: 'vertical' }],
      ownerRoleKey: 'office-admin',
    });
    await sql(copy, `DELETE FROM _substrat_meta WHERE key = 'provisioned_for'`);
    await sql(copy, 'DELETE FROM _substrat_roles');
    expect(await receiptOf(copy)).toBeNull();
    // Activation of a live scope in a never-restored directory posted nothing: nothing has asked.
    expect(askedFor(copy)).toBe(0);
    return { t, copy };
  };

  it('a role-free active copy is asked by the heal, records the directory\'s tenant, and is not asked again', async () => {
    const { t, copy } = await unrecordedCopy();
    const foreign = tenantId.parse(ulid());
    const door = () => deployment().attachments(owner, foreign, copy).then(() => undefined, (e: unknown) => e);
    // Before: nothing to hold the pair against, so a foreign tenant gets past the door.
    expect(errorCodeOf(await door())).not.toBe('not_found');
    await platform().healLifecycles(actor);
    expect(askedFor(copy)).toBe(1);
    expect(await receiptOf(copy)).toBe(t);
    expect(await recordedInDirectory(copy)).toBe(1);
    // After: the foreign tenant is refused at the door.
    expect(errorCodeOf(await door())).toBe('not_found');
    // Converged: the next pass leaves it alone.
    await platform().healLifecycles(actor);
    expect(askedFor(copy)).toBe(1);
  });

  it('a scope that cannot record yet (its deployment holds nothing) is asked again on the next pass', async () => {
    const t = tenantId.parse(ulid());
    await platform().admin.createTenant(actor, { id: t, slug: `rec-${t.toLowerCase()}`, name: 'Record' });
    const empty = scopeId.parse(ulid());
    await platform().provisionScope(actor, { tenantId: t, scopeId: empty, vertical: 'todo' });
    await platform().admin.activateScope(actor, t, empty);
    // This suite's directory and deployment share one scope namespace, so the directory's own
    // provision seated grants into the store; a load of nothing leaves the deployment's store empty.
    await deployment().restoreScopeLocal(empty, []);
    await platform().healLifecycles(actor);
    expect(askedFor(empty)).toBe(1);
    expect(await receiptOf(empty)).toBeNull();
    expect(await recordedInDirectory(empty)).toBe(0);
    await platform().healLifecycles(actor);
    expect(askedFor(empty)).toBe(2);
  });
});

/**
 * #2016, Codex #2033 r3: the heal's tenant-record walk rotates on the ASK, not on the answer. A
 * deployment that cannot be reached writes no receipt, so a walk ordered by the receipt put the same
 * unreachable scopes first on every pass, and a healthy copy past the per-pass slice was never asked.
 */
describe('the tenant-record walk rotates past deployments that never answer (#2016)', () => {
  const actor = platformActorId.parse(ulid());
  const owner = principalId.parse(ulid());
  const USE = permissionKey.parse('perm:use');
  const unreachable = new Set<string>();
  const asked: string[] = [];
  /** Run after the deployment answered and before the heal writes its receipt — the window in which
   *  a delete or a reap commits between the heal's select and its bookkeeping write. */
  let duringDelivery: ((s: ScopeId) => Promise<void>) | undefined;
  const deployment = () => new CloudflareScopeHost({ scope: env.SCOPE });
  const lifecycleDelegation: LifecycleDelegation = {
    deliver: async ({ tenantId: t, scopeId: s, lifecycle }) => {
      asked.push(s);
      if (unreachable.has(s)) throw new Error('deployment unreachable');
      const answer = await deployment().setLifecycleLocal(s, lifecycle, t);
      await duringDelivery?.(s);
      return answer;
    },
  };
  const directoryName = `tenant-walk-${ulid()}`;
  const directory = {
    idFromName: () => env.CONTROL_PLANE.idFromName(directoryName),
    get: (id: DurableObjectId) => env.CONTROL_PLANE.get(id),
  } as unknown as DurableObjectNamespace;
  const platform = () => new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: directory, lifecycleDelegation });
  beforeAll(() => warmControlPlane(directory));
  const receiptOf = (s: ScopeId) =>
    runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(s)), (_i, state) =>
      (state.storage.sql.exec(`SELECT value FROM _substrat_meta WHERE key = 'provisioned_for'`).toArray()[0] as { value: string } | undefined)?.value ?? null,
    );

  it('a full slice of unreachable scopes does not keep a healthy copy from being asked', async () => {
    const t = tenantId.parse(ulid());
    await platform().admin.createTenant(actor, { id: t, slug: `walk-${t.toLowerCase()}`, name: 'Walk' });
    // A whole pass's worth of scopes whose deployment never answers, all created (and so ordered by
    // id) ahead of the healthy one.
    for (let i = 0; i < TENANT_UNRECORDED_PER_PASS; i++) {
      const s = scopeId.parse(ulid());
      unreachable.add(s);
      await platform().provisionScope(actor, { tenantId: t, scopeId: s, vertical: 'todo' });
      await platform().admin.activateScope(actor, t, s);
    }
    const install = [...unreachable][0] as ScopeId;
    const copy = scopeId.parse(ulid());
    await platform().provisionScope(actor, { tenantId: t, scopeId: copy, vertical: 'todo', kind: 'preview', forkedFrom: install });
    await platform().admin.activateScope(actor, t, copy);
    await deployment().provisionScopeLocal({
      tenantId: t,
      scopeId: copy,
      owner,
      roles: [{ key: 'office-admin', permissions: [USE], source: 'vertical' }],
      ownerRoleKey: 'office-admin',
    });
    await runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(copy)), (_i, state) => {
      state.storage.sql.exec(`DELETE FROM _substrat_meta WHERE key = 'provisioned_for'`);
      state.storage.sql.exec('DELETE FROM _substrat_roles');
    });

    // The first pass fills its slice with the unreachable scopes, all failing.
    const first = await platform().healLifecycles(actor);
    expect(first.failed).toBeGreaterThanOrEqual(TENANT_UNRECORDED_PER_PASS);
    expect(asked).not.toContain(copy);
    // They rotate behind the scope not asked yet: the next pass reaches the copy.
    await platform().healLifecycles(actor);
    expect(asked.filter((s) => s === copy)).toHaveLength(1);
    expect(await receiptOf(copy)).toBe(t);
    // And the unreachable ones keep being asked on later passes, without the copy again.
    const before = asked.length;
    await platform().healLifecycles(actor);
    expect(asked.length - before).toBe(TENANT_UNRECORDED_PER_PASS);
    expect(asked.filter((s) => s === copy)).toHaveLength(1);
    // A full slice is the point of the case: fifty provisions and three passes of about fifty
    // deliveries each, against the real directory. Under a loaded full suite that outruns the
    // default 5 s, though it takes under a second alone.
  }, 60_000);

  /** The directory's delivery bookkeeping for `s`: its tenant-record asks and its delivery receipts. */
  const bookkeepingOf = (s: ScopeId) =>
    runInDurableObject(env.CONTROL_PLANE.get(directory.idFromName('')), (_i, state) => ({
      asks: state.storage.sql.exec('SELECT 1 FROM scope_tenant_asks WHERE scope_id = ?', s).toArray().length,
      receipts: state.storage.sql.exec('SELECT 1 FROM scope_lifecycle_receipts WHERE scope_id = ?', s).toArray().length,
    }));
  const tenantOf = async () => {
    const t = tenantId.parse(ulid());
    await platform().admin.createTenant(actor, { id: t, slug: `walk-${t.toLowerCase()}`, name: 'Walk' });
    return t;
  };
  const served = async (t: TenantId, extra: { kind?: string; forkedFrom?: ScopeId } = {}) => {
    const s = scopeId.parse(ulid());
    await platform().provisionScope(actor, { tenantId: t, scopeId: s, vertical: 'todo', ...extra });
    await platform().admin.activateScope(actor, t, s);
    return s;
  };

  it('deleting an asked preview takes its ask and its delivery receipt with it', async () => {
    const t = await tenantOf();
    const install = await served(t);
    const preview = await served(t, { kind: 'preview', forkedFrom: install });
    await platform().healLifecycles(actor);
    expect(await bookkeepingOf(preview)).toEqual({ asks: 1, receipts: 1 });
    await platform().deleteSnapshot(actor, t, preview);
    expect(await bookkeepingOf(preview)).toEqual({ asks: 0, receipts: 0 });
    // The twin: its install keeps its own.
    expect(await bookkeepingOf(install)).toEqual({ asks: 1, receipts: 1 });
  });

  /** The two bookkeeping writes a heal makes after its select, made late, straight to the directory. */
  const lateWrites = async (s: ScopeId) => {
    const dir = env.CONTROL_PLANE.get(directory.idFromName('')) as unknown as {
      recordTenantAsks(ids: string[], at: string): Promise<void>;
      recordLifecycleReceipt(id: string, delivered: string, at: string, tenantRecorded?: boolean): Promise<void>;
    };
    const at = new Date().toISOString();
    await dir.recordTenantAsks([s], at);
    await dir.recordLifecycleReceipt(s, 'active/active@0.0.0', at, true);
  };

  describe('a write that lands after the scope is gone recreates nothing (Codex #2037 r2)', () => {
    it('twin: a scope still served records both', async () => {
      const t = await tenantOf();
      const s = await served(t);
      await lateWrites(s);
      expect(await bookkeepingOf(s)).toEqual({ asks: 1, receipts: 1 });
    });

    it('after a delete', async () => {
      const t = await tenantOf();
      const install = await served(t);
      const preview = await served(t, { kind: 'preview', forkedFrom: install });
      await platform().deleteSnapshot(actor, t, preview);
      await lateWrites(preview);
      expect(await bookkeepingOf(preview)).toEqual({ asks: 0, receipts: 0 });
    });

    it('after a scope reap', async () => {
      const t = await tenantOf();
      const s = await served(t);
      await platform().admin.archiveScope(actor, t, s);
      await platform().admin.reapScope(actor, t, s, { force: true });
      await lateWrites(s);
      expect(await bookkeepingOf(s)).toEqual({ asks: 0, receipts: 0 });
    });

    it('after a tenant reap', async () => {
      const t = await tenantOf();
      const s = await served(t);
      await platform().admin.setTenantStatus(actor, t, 'deleting');
      await platform().admin.reapTenant(actor, t);
      await lateWrites(s);
      expect(await bookkeepingOf(s)).toEqual({ asks: 0, receipts: 0 });
    });

    it('a preview deleted while its delivery is in flight keeps neither its ask nor a receipt', async () => {
      const t = await tenantOf();
      const install = await served(t);
      const preview = await served(t, { kind: 'preview', forkedFrom: install });
      duringDelivery = async (s) => {
        if (s === preview) await platform().deleteSnapshot(actor, t, preview);
      };
      try {
        await platform().healLifecycles(actor);
      } finally {
        duringDelivery = undefined;
      }
      expect(asked).toContain(preview);
      // The deployment answered, so the heal went on to write the receipt; the delete had won.
      expect(await bookkeepingOf(preview)).toEqual({ asks: 0, receipts: 0 });
    });
  });

  it('a reaped scope, and a reaped tenant\'s scopes, keep no delivery bookkeeping', async () => {
    const t = await tenantOf();
    const reaped = await served(t);
    const leftOver = await served(t);
    await platform().healLifecycles(actor);
    expect(await bookkeepingOf(reaped)).toEqual({ asks: 1, receipts: 1 });
    expect(await bookkeepingOf(leftOver)).toEqual({ asks: 1, receipts: 1 });
    await platform().admin.archiveScope(actor, t, reaped);
    await platform().admin.reapScope(actor, t, reaped, { force: true });
    expect(await bookkeepingOf(reaped)).toEqual({ asks: 0, receipts: 0 });
    // A scope the tenant reap finds not yet reaped on its own goes with the tenant.
    await platform().admin.setTenantStatus(actor, t, 'deleting');
    await platform().admin.reapTenant(actor, t);
    expect(await bookkeepingOf(leftOver)).toEqual({ asks: 0, receipts: 0 });
  });
});
