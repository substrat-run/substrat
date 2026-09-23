import { env } from 'cloudflare:test';
import { beforeAll, expect, it, vi } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { CloudflareScopeHost } from '../src/host.js';
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
