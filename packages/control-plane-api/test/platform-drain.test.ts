import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import {
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  platformRequestId,
  type PlatformRequest,
  type EntitlementGrant,
} from '@substrat-run/contracts';
import {
  drainScopePlatformRequests,
  provisionSiblingHandler,
  archiveScopeHandler,
  provisionTenantHandler,
  setEntitlementsHandler,
  type PlatformRequestHandler,
  VerticalClient,
} from '../src/index.js';

/** A minimal well-formed intent row for the dispatcher tests. */
function intent(kind: string, over: Partial<PlatformRequest> = {}): PlatformRequest {
  return {
    id: platformRequestId.parse(ulid()),
    kind,
    payload: {},
    requestedBy: principalId.parse(ulid()),
    status: 'pending',
    attempts: 0,
    lastError: null,
    result: null,
    requestedAt: new Date().toISOString() as PlatformRequest['requestedAt'],
    settledAt: null,
    ...over,
  };
}

/** A fake VerticalClient transport that records settlements. */
function fakeTransport(pending: PlatformRequest[]) {
  const settled: Array<{ id: string; status: string; result?: unknown; lastError?: string | null }> = [];
  const client = {
    listPlatformRequests: async () => pending,
    settlePlatformRequest: async (
      _t: unknown,
      _s: unknown,
      id: string,
      outcome: { status: string; result?: unknown; lastError?: string | null },
    ) => {
      settled.push({ id, ...outcome });
    },
  } as unknown as Pick<VerticalClient, 'listPlatformRequests' | 'settlePlatformRequest'>;
  return { client, settled };
}

describe('drainScopePlatformRequests — the kind→handler dispatcher', () => {
  const ctx = { tenantId: tenantId.parse(ulid()), scopeId: scopeId.parse(ulid()), vertical: 'demo-vert' };

  it('dispatches to the handler for each kind and settles its outcome', async () => {
    const done = intent('provision-sibling');
    const { client, settled } = fakeTransport([done]);
    const handler: PlatformRequestHandler = async () => ({ status: 'done', result: { scopeId: 'NEW' } });

    const report = await drainScopePlatformRequests(client, ctx, { 'provision-sibling': handler });

    expect(report).toEqual({ drained: 1, done: 1, failed: 0, pending: 0 });
    expect(settled).toEqual([{ id: done.id, status: 'done', result: { scopeId: 'NEW' }, lastError: null }]);
  });

  it('settles an unknown kind as failed — never a silent drop', async () => {
    const unknown = intent('mystery');
    const { client, settled } = fakeTransport([unknown]);
    const report = await drainScopePlatformRequests(client, ctx, {});
    expect(report.failed).toBe(1);
    expect(settled[0]!.status).toBe('failed');
    expect(settled[0]!.lastError).toMatch(/no handler for platform-request kind 'mystery'/);
  });

  it('a thrown handler settles pending (transient — retried next drain)', async () => {
    const req = intent('provision-sibling');
    const { client, settled } = fakeTransport([req]);
    const boom: PlatformRequestHandler = async () => {
      throw new Error('vertical unreachable');
    };
    const report = await drainScopePlatformRequests(client, ctx, { 'provision-sibling': boom });
    expect(report.pending).toBe(1);
    expect(settled[0]!.status).toBe('pending');
    expect(settled[0]!.lastError).toMatch(/vertical unreachable/);
  });
});

describe('provisionSiblingHandler — provisions a sibling of the drained scope', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const parent = scopeId.parse(ulid());
  const owner = principalId.parse(ulid());

  let captured: { scopeId?: string; owner?: string; entitlements?: EntitlementGrant[] } | undefined;
  const fakeVertical = {
    provisionInstance: async (input: { scopeId: string; owner: string; entitlements?: EntitlementGrant[] }) => {
      captured = input;
      return { tenantId: t, scopeId: input.scopeId, owner };
    },
  } as unknown as VerticalClient;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-drain-'));
    host = new SqliteScopeHost({ dir });
    await host.admin.createTenant(staff, { id: t, slug: 'acme', name: 'Acme' });
    await host.provisionScope(staff, { tenantId: t, scopeId: parent, vertical: 'demo-vert' });
    await host.admin.activateScope(staff, t, parent);
    await host.admin.grantEntitlement(staff, t, 'demo-vert', { quota: 5, plan: 'pro' });
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('provisions + activates the sibling under the parent tenant, seating the owner', async () => {
    const handler = provisionSiblingHandler({
      host,
      actor: staff,
      resolveVerticalForScope: async () => fakeVertical,
    });
    const req = intent('provision-sibling', { payload: { slug: 'padel', name: 'Padel Club', owner } });

    const outcome = await handler({ tenantId: t, scopeId: parent, vertical: 'demo-vert' }, req);

    expect(outcome.status).toBe('done');
    const newScopeId = (outcome.result as { scopeId: string }).scopeId;
    // The sibling exists, is active, and inherited the parent's vertical.
    const record = await host.admin.getScopeRecord(staff, t, scopeId.parse(newScopeId));
    expect(record?.status).toBe('active');
    expect(record?.vertical).toBe('demo-vert');
    // The vertical materialized the instance with the seated owner + the platform-gathered plan.
    expect(captured?.scopeId).toBe(newScopeId);
    expect(captured?.owner).toBe(owner);
    expect(captured?.entitlements?.find((e) => e.entitlementKey === 'demo-vert')).toMatchObject({ quota: 5 });
  });
});

describe('archiveScopeHandler — archives a sibling named in the intent', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const current = scopeId.parse(ulid()); // the scope the intent was drained from
  const target = scopeId.parse(ulid()); // the sibling to archive

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-archive-'));
    host = new SqliteScopeHost({ dir });
    await host.admin.createTenant(staff, { id: t, slug: 'acme', name: 'Acme' });
    for (const s of [current, target]) {
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'demo-vert' });
      await host.admin.activateScope(staff, t, s);
    }
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const handler = () => archiveScopeHandler({ host, actor: staff });
  const ctx = { tenantId: t, scopeId: current, vertical: 'demo-vert' };

  it('archives the target scope, and is idempotent on a re-run', async () => {
    const outcome = await handler()(ctx, intent('archive-scope', { payload: { scopeId: target } }));
    expect(outcome.status).toBe('done');
    expect((await host.admin.getScopeRecord(staff, t, target))?.status).toBe('archived');

    // Idempotent: an already-archived target is a no-op success (a retry never wedges).
    const again = await handler()(ctx, intent('archive-scope', { payload: { scopeId: target } }));
    expect(again.status).toBe('done');
  });

  it('refuses a target running a different vertical (bounded to the drained scope\'s vertical)', async () => {
    const foreign = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: foreign, vertical: 'other-vert' });
    await host.admin.activateScope(staff, t, foreign);

    const outcome = await handler()(ctx, intent('archive-scope', { payload: { scopeId: foreign } }));
    expect(outcome.status).toBe('failed');
    expect((await host.admin.getScopeRecord(staff, t, foreign))?.status).toBe('active'); // untouched
  });
});

describe('provisionTenantHandler — a manager vertical creates a NEW customer tenant (#412)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const staff = platformActorId.parse(ulid());
  const managerTenant = tenantId.parse(ulid());
  const managerScope = scopeId.parse(ulid());
  const owner = principalId.parse(ulid());
  const ctx = { tenantId: managerTenant, scopeId: managerScope, vertical: 'manager-console' };

  let provisioned: { scopeId?: string; owner?: string; entitlements?: EntitlementGrant[] } | undefined;
  let configured: { entries?: Array<{ key: string; value: string }> } | undefined;
  const fakeVertical = {
    provisionInstance: async (input: {
      tenantId: string;
      scopeId: string;
      owner: string;
      entitlements?: EntitlementGrant[];
    }) => {
      provisioned = input;
      return { tenantId: input.tenantId, scopeId: input.scopeId, owner: input.owner };
    },
    configureInstance: async (input: { entries: Array<{ key: string; value: string }> }) => {
      configured = input;
    },
  } as unknown as VerticalClient;

  const deps = () => ({
    host,
    actor: staff,
    provisioners: ['manager-console'],
    resolveVerticalForScope: async () => fakeVertical,
  });

  /** A well-formed provision-tenant payload; ids proposed by the caller (idempotent join keys). */
  const payloadFor = (t: string, s: string) => ({
    tenant: { id: t, slug: `customer-${t.slice(-8).toLowerCase()}`, name: 'Customer One' },
    instance: { vertical: 'managed-product', scopeId: s, slug: 'main', name: 'Main', owner },
    entitlements: [{ key: 'flows', plan: 'pro' }],
    config: { ISSUER_DOMAIN: 'auth.customer-1.example' },
  });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-provtenant-'));
    host = new SqliteScopeHost({ dir });
    // The manager's registration carries its declared SKU universe (invariant 3's bound).
    await host.admin.registerVertical(staff, {
      slug: 'manager-console',
      name: 'Manager Console',
      source: 'builtin',
      entitlements: ['flows', 'vault'],
    });
    await host.admin.createTenant(staff, { id: managerTenant, slug: 'manager', name: 'Manager' });
    await host.provisionScope(staff, { tenantId: managerTenant, scopeId: managerScope, vertical: 'manager-console' });
    await host.admin.activateScope(staff, managerTenant, managerScope);
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the tenant + first scope of the PAYLOAD vertical, grants + projects, delivers config, activates', async () => {
    const newTenant = ulid();
    const newScope = ulid();
    const outcome = await provisionTenantHandler(deps())(
      ctx,
      intent('provision-tenant', { payload: payloadFor(newTenant, newScope) }),
    );

    expect(outcome).toMatchObject({ status: 'done', result: { tenantId: newTenant, scopeId: newScope } });
    const record = await host.admin.getScopeRecord(staff, tenantId.parse(newTenant), scopeId.parse(newScope));
    expect(record?.status).toBe('active');
    expect(record?.vertical).toBe('managed-product'); // the payload's vertical, never the manager's
    // The instance was materialized with the granted plan projected (#310) and config delivered.
    expect(provisioned?.scopeId).toBe(newScope);
    expect(provisioned?.owner).toBe(owner);
    expect(provisioned?.entitlements?.find((e) => e.entitlementKey === 'flows')).toMatchObject({ plan: 'pro' });
    expect(configured?.entries).toEqual([{ key: 'ISSUER_DOMAIN', value: 'auth.customer-1.example' }]);
  });

  it('converges on a re-drain: same proposed ids, every step an idempotent no-op', async () => {
    const newTenant = ulid();
    const newScope = ulid();
    const run = () =>
      provisionTenantHandler(deps())(ctx, intent('provision-tenant', { payload: payloadFor(newTenant, newScope) }));
    expect((await run()).status).toBe('done');
    const again = await run();
    expect(again).toMatchObject({ status: 'done', result: { tenantId: newTenant, scopeId: newScope } });
  });

  it('refuses a vertical without the provisioner capability — terminal, with a reason', async () => {
    const outcome = await provisionTenantHandler(deps())(
      { ...ctx, vertical: 'some-other-vertical' },
      intent('provision-tenant', { payload: payloadFor(ulid(), ulid()) }),
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/tenant-provisioner capability/);
  });

  it('refuses an entitlement key outside the manager\'s declared SKUs', async () => {
    const payload = { ...payloadFor(ulid(), ulid()), entitlements: [{ key: 'not-declared', plan: null }] };
    const outcome = await provisionTenantHandler(deps())(ctx, intent('provision-tenant', { payload }));
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/'not-declared' is not among the SKUs/);
  });

  it('a tenant slug owned by a DIFFERENT id settles failed (a retry can never converge)', async () => {
    const first = payloadFor(ulid(), ulid());
    expect((await provisionTenantHandler(deps())(ctx, intent('provision-tenant', { payload: first }))).status).toBe(
      'done',
    );
    // Same slug, different proposed tenant id — the fail-closed slug check, surfaced terminal.
    const clash = payloadFor(ulid(), ulid());
    clash.tenant.slug = first.tenant.slug;
    const outcome = await provisionTenantHandler(deps())(ctx, intent('provision-tenant', { payload: clash }));
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/slugs are unique/);
  });

  it('an unbound target vertical settles failed, naming it', async () => {
    const unbound = { ...deps(), resolveVerticalForScope: async () => undefined };
    const payload = { ...payloadFor(ulid(), ulid()), tenant: { id: ulid(), slug: 'customer-2', name: 'Two' } };
    const outcome = await provisionTenantHandler(unbound)(ctx, intent('provision-tenant', { payload }));
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/no deployment is bound for vertical 'managed-product'/);
  });
});

describe('setEntitlementsHandler — reconcile a managed tenant to a plan\'s target set (#412)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const staff = platformActorId.parse(ulid());
  const managerTenant = tenantId.parse(ulid());
  const managerScope = scopeId.parse(ulid());
  const customer = tenantId.parse(ulid());
  const authScope = scopeId.parse(ulid());
  const ctx = { tenantId: managerTenant, scopeId: managerScope, vertical: 'manager-console' };

  let reconciled: { scopeId?: string; entitlements?: EntitlementGrant[] } | undefined;
  const fakeVertical = {
    reconcileInstance: async (input: { scopeId: string; entitlements?: EntitlementGrant[] }) => {
      reconciled = input;
      return { tenantId: customer, scopeId: input.scopeId, repaired: false };
    },
  } as unknown as VerticalClient;

  const deps = () => ({
    host,
    actor: staff,
    provisioners: ['manager-console'],
    resolveVerticalForScope: async () => fakeVertical,
  });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-setent-'));
    host = new SqliteScopeHost({ dir });
    await host.admin.registerVertical(staff, {
      slug: 'manager-console',
      name: 'Manager Console',
      source: 'builtin',
      entitlements: ['flows', 'vault'],
    });
    await host.admin.createTenant(staff, { id: customer, slug: 'customer', name: 'Customer' });
    await host.provisionScope(staff, { tenantId: customer, scopeId: authScope, vertical: 'managed-product' });
    await host.admin.activateScope(staff, customer, authScope);
    // The state a downgrade reconciles away from: 'flows' held, plus a PLATFORM-granted
    // key outside the manager's declared universe that must survive untouched.
    await host.admin.grantEntitlement(staff, customer, 'flows', { plan: 'pro' });
    await host.admin.grantEntitlement(staff, customer, 'managed-product', { plan: 'base' });
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('grants the target, revokes declared-but-absent, leaves undeclared keys alone, re-projects', async () => {
    const outcome = await setEntitlementsHandler(deps())(
      ctx,
      intent('set-entitlements', {
        payload: {
          tenantId: customer,
          authScopeId: authScope,
          plan: 'enterprise',
          entitlements: [{ key: 'vault', plan: 'enterprise' }],
        },
      }),
    );

    expect(outcome).toMatchObject({ status: 'done', result: { tenantId: customer, plan: 'enterprise' } });
    const held = await host.admin.listEntitlements(staff, customer);
    const keys = held.map((e) => e.entitlementKey).sort();
    expect(keys).toEqual(['managed-product', 'vault']); // 'flows' revoked, platform grant untouched
    expect(held.find((e) => e.entitlementKey === 'vault')).toMatchObject({ plan: 'enterprise' });
    // Re-projected into the auth scope with the authoritative post-reconcile set.
    expect(reconciled?.scopeId).toBe(authScope);
    expect(reconciled?.entitlements?.map((e) => e.entitlementKey).sort()).toEqual(['managed-product', 'vault']);
  });

  it('refuses a target key outside the declared universe before touching anything', async () => {
    const outcome = await setEntitlementsHandler(deps())(
      ctx,
      intent('set-entitlements', {
        payload: { tenantId: customer, authScopeId: authScope, plan: 'x', entitlements: [{ key: 'rogue', plan: null }] },
      }),
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/'rogue' is not among the SKUs/);
  });

  it('an unknown auth scope settles failed', async () => {
    const outcome = await setEntitlementsHandler(deps())(
      ctx,
      intent('set-entitlements', {
        payload: { tenantId: customer, authScopeId: ulid(), plan: 'x', entitlements: [] },
      }),
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/unknown scope for tenant/);
  });
});
