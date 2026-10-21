import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, expect, it } from 'vitest';
import { permissionKey, platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { permMod } from '@substrat-run/contract-tests';
import { ulid, UNSAFE_allowAllChecker } from '@substrat-run/kernel';
import { ControlPlaneDO } from '../src/control-plane-do.js';
import { createLocalControlPlaneReader } from '../src/checker.js';
import { defineScopeDO } from '../src/scope-do.js';
import { CloudflareScopeHost } from './test-host.js';
import { warmControlPlane } from './do-warmup.js';

beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

it('adds the directory holder column to an old role and persists the same role redefined', async () => {
  const stub = env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName(`role-holder-${ulid()}`)) as unknown as {
    defineRole(tenantId: string, role: { key: string; permissions: string[]; source: 'vertical'; holder?: 'system' }): Promise<unknown>;
    getRole(tenantId: string, key: string): Promise<{ holder?: string } | undefined>;
  };
  const tenant = ulid();
  const role = { key: 'runner', permissions: ['rsv:run'], source: 'vertical' as const };
  await stub.defineRole(tenant, role);
  const staged = await runInDurableObject(stub as never, (_instance, state) => {
    state.storage.sql.exec('ALTER TABLE _substrat_roles DROP COLUMN holder');
    const old = state.storage.sql.exec('SELECT role_key, permissions FROM _substrat_roles').toArray();
    new ControlPlaneDO(state, env);
    return { old, row: state.storage.sql.exec('SELECT holder FROM _substrat_roles').toArray() };
  });
  expect(staged.old).toEqual([{ role_key: 'runner', permissions: '["rsv:run"]' }]);
  expect(staged.row).toEqual([{ holder: null }]);
  expect((await stub.getRole(tenant, 'runner'))?.holder).toBeUndefined();
  await stub.defineRole(tenant, { ...role, holder: 'system' });
  expect((await stub.getRole(tenant, 'runner'))?.holder).toBe('system');
});

it('adds the scope projection column to an old role and reads a new holder', async () => {
  const stub = env.SCOPE.get(env.SCOPE.idFromName(`role-holder-${ulid()}`)) as unknown as {
    projectRole(tenantId: string, role: { key: string; permissions: string[]; source: string; holder?: 'system' }): Promise<void>;
  };
  const tenant = ulid();
  const role = { key: 'runner', permissions: ['rsv:run'], source: 'vertical' };
  await stub.projectRole(tenant, role);
  const old = await runInDurableObject(stub as never, async (_instance, state) => {
    state.storage.sql.exec('ALTER TABLE _substrat_roles DROP COLUMN holder');
    const ScopeDO = defineScopeDO([], {});
    new ScopeDO(state, env);
    return createLocalControlPlaneReader(state.storage.sql).getRole(tenant, 'runner');
  });
  expect(old?.holder).toBeUndefined();
  await stub.projectRole(tenant, { ...role, holder: 'system' });
  const current = await runInDurableObject(stub as never, async (_instance, state) =>
    createLocalControlPlaneReader(state.storage.sql).getRole(tenant, 'runner'));
  expect(current?.holder).toBe('system');
});

it('carries the directory holder through the full projection wire into the scope store', async () => {
  const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE, checker: UNSAFE_allowAllChecker, scopeLocalPermissions: true });
  host.registerModule(permMod);
  const staff = platformActorId.parse(ulid());
  const tenant = tenantId.parse(ulid());
  const scope = scopeId.parse(ulid());
  await host.admin.createTenant(staff, { id: tenant, slug: `holder-${ulid().toLowerCase()}`, name: 'Holder' });
  await host.provisionScope(staff, { tenantId: tenant, scopeId: scope, vertical: 'holder-vertical' });
  await host.admin.activateScope(staff, tenant, scope);
  await host.admin.defineRole(staff, tenant, {
    key: 'runner', permissions: [permissionKey.parse('rsv:run')], source: 'vertical', holder: 'system',
  });
  const stored = await runInDurableObject(env.SCOPE.get(env.SCOPE.idFromName(scope)), (_instance, state) =>
    state.storage.sql.exec('SELECT holder FROM _substrat_roles WHERE tenant_id = ? AND role_key = ?', tenant, 'runner').toArray());
  expect(stored).toEqual([{ holder: 'system' }]);
});
