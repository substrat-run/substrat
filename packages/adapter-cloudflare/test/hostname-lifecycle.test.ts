import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { permissionKey, platformActorId, principalId, scopeId, tenantId, type ScopeId, type ScopeLifecycle, type TenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { CloudflareScopeHost, type LifecycleDelegation } from '../src/host.js';
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
  const platform = () => new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE, lifecycleDelegation });
  const USE = permissionKey.parse('perm:use');

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
    // Activation is a transition too, but a live scope its deployment already runs live has
    // nothing to receive, so nothing is posted (a deployment without the route logs nothing).
    expect(deliveredTo(s)).toEqual([]);
    return s;
  };
  const servedHere = (t: TenantId, s: ScopeId) => deployment().getScope(owner, t, s);

  it('a suspend reaches the deployment, which then refuses in the directory\'s words; unsuspend lifts it', async () => {
    const t = await tenantOf();
    const s = await hosted(t);
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
      { scope: 2, tenant: 0 },
      { scope: 2, tenant: 1 },
      { scope: 3, tenant: 1 },
      { scope: 3, tenant: 2 },
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
