import { env } from 'cloudflare:test';
import { beforeAll, expect, it } from 'vitest';
import { platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import type { ControlPlaneDO } from '../src/control-plane-do.js';
import { CloudflareScopeHost } from '../src/host.js';
import { warmControlPlane } from './do-warmup.js';

beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

it('peer resolution refuses an active scope in a suspended tenant, then admits it after restore', async () => {
  const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
  const actor = platformActorId.parse(ulid());
  const tenant = tenantId.parse(ulid());
  const caller = scopeId.parse(ulid());
  const target = scopeId.parse(ulid());
  await host.admin.createTenant(actor, { id: tenant, slug: `peer-${tenant.toLowerCase()}`, name: 'Peer' });
  for (const [scope, vertical] of [[caller, 'acme/board-room'], [target, 'acme/crm']] as const) {
    await host.provisionScope(actor, { tenantId: tenant, scopeId: scope, vertical });
    await host.admin.activateScope(actor, tenant, scope);
  }
  const read = () => (env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName('control-plane')) as unknown as DurableObjectStub<ControlPlaneDO>)
    .peerCallTarget(tenant, caller, 'acme/board-room', 'acme/crm');
  expect((await read()).caller.state).toBe('ok');
  await host.admin.setTenantStatus(actor, tenant, 'suspended');
  expect((await host.admin.getScopeRecord(actor, tenant, caller))?.status).toBe('active');
  expect((await read()).caller).toEqual({ state: 'inactive', status: 'tenant suspended' });
  await host.admin.setTenantStatus(actor, tenant, 'active');
  expect((await read()).caller.state).toBe('ok');
});

it('the hosted peer read routes only to the caller’s explicit live target', async () => {
  const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
  const actor = platformActorId.parse(ulid());
  const tenant = tenantId.parse(ulid());
  const foreignTenant = tenantId.parse(ulid());
  const caller = scopeId.parse(ulid());
  const first = scopeId.parse(ulid());
  const second = scopeId.parse(ulid());
  const foreign = scopeId.parse(ulid());
  for (const id of [tenant, foreignTenant]) await host.admin.createTenant(actor, { id, slug: `peer-${id.toLowerCase()}`, name: 'Peer' });
  for (const [id, scope, vertical] of [
    [tenant, caller, 'acme/board-room'], [tenant, first, 'acme/crm'],
    [tenant, second, 'acme/crm'], [foreignTenant, foreign, 'acme/crm'],
  ] as const) {
    await host.provisionScope(actor, { tenantId: id, scopeId: scope, vertical });
    await host.admin.activateScope(actor, id, scope);
  }
  const dir = env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName('control-plane')) as unknown as DurableObjectStub<ControlPlaneDO>;
  const read = () => dir.peerCallTarget(tenant, caller, 'acme/board-room', 'acme/crm');
  expect((await read()).outcome).toBe('ambiguous');
  await host.admin.setPeerBinding(actor, tenant, caller, 'acme/crm', second);
  expect((await read()).target?.scope_id).toBe(second);
  // A stale/forged tenant claim cannot borrow this caller's saved binding.
  expect((await dir.peerCallTarget(foreignTenant, caller, 'acme/board-room', 'acme/crm')).caller.state).toBe('unknown');
  await host.admin.suspendScope(actor, tenant, second);
  expect((await read()).outcome).toBe('bound-unavailable');
  await host.admin.unsuspendScope(actor, tenant, second);
  expect((await read()).target?.scope_id).toBe(second);
  await host.admin.archiveScope(actor, tenant, second);
  await host.admin.unarchiveScope(actor, tenant, second);
  expect((await read()).outcome).toBe('bound-unavailable');
  await host.admin.setPeerBinding(actor, tenant, caller, 'acme/crm', second);
  expect((await read()).target?.scope_id).toBe(second);
  await expect(host.admin.setPeerBinding(actor, tenant, caller, 'acme/crm', foreign)).rejects.toThrow();
  expect((await read()).target?.scope_id).toBe(second);
});
