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
