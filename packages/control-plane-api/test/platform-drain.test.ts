import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ControlPlaneError } from '../src/client.js';
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
  MAX_PLATFORM_REQUEST_ATTEMPTS,
  provisionSiblingHandler,
  archiveScopeHandler,
  provisionTenantHandler,
  setEntitlementsHandler,
  connectorDispatchHandler,
  type PlatformRequestHandler,
  ControlPlaneError,
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
    // `failure: null` on a success — nothing refused, so there is nothing to attribute (#841).
    expect(settled).toEqual([
      { id: done.id, status: 'done', result: { scopeId: 'NEW' }, lastError: null, failure: null },
    ]);
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

  it('the attempt ceiling (#570): a pending outcome at the ceiling settles failed + records an ops-failure', async () => {
    // 577 attempts into the acme incident, `pending` was a lie only the spine table knew.
    const stuck = intent('provision-tenant', { attempts: MAX_PLATFORM_REQUEST_ATTEMPTS - 1 });
    const { client, settled } = fakeTransport([stuck]);
    const failures: Array<{ operation: string; stage?: string | null; message: string }> = [];
    const refusing: PlatformRequestHandler = async () => ({
      status: 'pending',
      result: { tenantId: 'T', scopeId: 'S' },
      error: 'vertical refused provisioning (503): no tenant store attached',
    });

    const report = await drainScopePlatformRequests(
      client,
      ctx,
      { 'provision-tenant': refusing },
      { recordFailure: (e) => failures.push(e) },
    );

    expect(report).toEqual({ drained: 1, done: 0, failed: 1, pending: 0 });
    expect(settled[0]!.status).toBe('failed');
    // The proposer reads the truth: how long the platform tried, and the last real error.
    expect(settled[0]!.lastError).toMatch(new RegExp(`gave up after ${MAX_PLATFORM_REQUEST_ATTEMPTS} drain attempts`));
    expect(settled[0]!.lastError).toMatch(/no tenant store attached/);
    // Two-phase idempotency survives the give-up: the proposed ids stay persisted.
    expect(settled[0]!.result).toEqual({ tenantId: 'T', scopeId: 'S' });
    // …and the operator gets a durable #559 row instead of a spine-table archaeology find.
    expect(failures).toEqual([
      expect.objectContaining({
        operation: 'intent.provision-tenant',
        stage: 'attempt-ceiling',
        tenantId: ctx.tenantId,
        scopeId: ctx.scopeId,
        vertical: ctx.vertical,
        message: expect.stringMatching(stuck.id),
      }),
    ]);
  });

  it('below the ceiling a pending outcome stays pending — no give-up, no ops-failure row', async () => {
    const req = intent('provision-tenant', { attempts: MAX_PLATFORM_REQUEST_ATTEMPTS - 2 });
    const { client, settled } = fakeTransport([req]);
    const failures: unknown[] = [];
    const refusing: PlatformRequestHandler = async () => ({ status: 'pending', error: 'still warming up' });

    const report = await drainScopePlatformRequests(
      client,
      ctx,
      { 'provision-tenant': refusing },
      { recordFailure: (e) => failures.push(e) },
    );

    expect(report.pending).toBe(1);
    expect(settled[0]!.status).toBe('pending');
    expect(failures).toEqual([]);
  });
});

describe('connectorDispatchHandler — executes a routed connector delivery (#574 phase 3)', () => {
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const ctx = { tenantId: t, scopeId: s, vertical: 'meridian' };

  /** A kernel-stamped event as the routing host embeds it — JSON-shaped, parsed at drain. */
  const routedEvent = (over: Record<string, unknown> = {}) => ({
    id: ulid(),
    type: 'protocol.signatures-requested',
    schemaVersion: 1,
    occurredAt: new Date().toISOString(),
    tenantId: t,
    scopeId: s,
    actor: { system: 'protocol' },
    entity: { entityType: 'protocol', entityId: '01JPROTO000000000000000000' },
    piiClass: 'none',
    payload: { instanceId: 'i1' },
    ...over,
  });

  /**
   * A fake host recording `dispatchConnector` calls; `boom` makes it throw instead. `status`
   * attaches an HTTP status to that throw the way every connector's error type does
   * (`ScriveApiError`) — which is exactly what the drain now classifies on (#618).
   */
  function recordingHost(boom?: string, status?: number) {
    const dispatched: Array<{ tenantId: string; scopeId: string; eventId: string }> = [];
    const host = {
      dispatchConnector: async (
        tenant: string,
        scope: string,
        _handler: unknown,
        event: { id: string },
      ) => {
        if (boom) throw Object.assign(new Error(boom), status === undefined ? {} : { status });
        dispatched.push({ tenantId: tenant, scopeId: scope, eventId: event.id });
      },
    } as unknown as Parameters<typeof connectorDispatchHandler>[0]['host'];
    return { host, dispatched };
  }
  const connector = async () => undefined;

  it('dispatches the embedded event through the host and settles done', async () => {
    const event = routedEvent();
    const req = intent('connector:scrive', { payload: { executorId: 'scrive', event } });
    const { client, settled } = fakeTransport([req]);
    const { host, dispatched } = recordingHost();

    const report = await drainScopePlatformRequests(client, ctx, {
      'connector:scrive': connectorDispatchHandler({ host, connector }),
    });

    expect(report).toEqual({ drained: 1, done: 1, failed: 0, pending: 0 });
    expect(dispatched).toEqual([{ tenantId: t, scopeId: s, eventId: event.id }]);
    expect(settled[0]).toEqual({
      id: req.id,
      status: 'done',
      result: { eventId: event.id },
      lastError: null,
      failure: null,
    });
  });

  it('refuses an event whose kernel stamps disagree with the drained scope — terminal, no dispatch', async () => {
    const forged = routedEvent({ tenantId: tenantId.parse(ulid()) });
    const req = intent('connector:scrive', { payload: { executorId: 'scrive', event: forged } });
    const { client, settled } = fakeTransport([req]);
    const { host, dispatched } = recordingHost();

    const report = await drainScopePlatformRequests(client, ctx, {
      'connector:scrive': connectorDispatchHandler({ host, connector }),
    });

    expect(report.failed).toBe(1);
    expect(dispatched).toEqual([]);
    expect(settled[0]!.status).toBe('failed');
    expect(settled[0]!.lastError).toMatch(/not the drained scope/);
  });

  it('a throwing dispatch (provider down, no live connection yet) settles pending and retries', async () => {
    const req = intent('connector:scrive', {
      payload: { executorId: 'scrive', event: routedEvent() },
    });
    const { client, settled } = fakeTransport([req]);
    const { host } = recordingHost("no live 'scrive' connection for tenant");

    const report = await drainScopePlatformRequests(client, ctx, {
      'connector:scrive': connectorDispatchHandler({ host, connector }),
    });

    expect(report.pending).toBe(1);
    expect(settled[0]!.status).toBe('pending');
    expect(settled[0]!.lastError).toMatch(/no live 'scrive' connection/);
  });

  // #618. The production case: three signature requests failed on a permanent 409 since
  // 9 August, were retried 100 times each over two days, and never reached a counterparty.
  // A 4xx is the provider telling the CALLER its request is wrong; attempt 101 sends the
  // identical bytes, so the only thing the retries bought was two days of silence.
  it("settles a provider's 4xx terminal on the FIRST attempt — a refused request is not transient", async () => {
    const req = intent('connector:scrive', { payload: { executorId: 'scrive', event: routedEvent() } });
    const { client, settled } = fakeTransport([req]);
    const { host } = recordingHost(
      'scrive start failed: HTTP 409 Authentication to sign for participant #1 requires valid personal number field.',
      409,
    );
    const failures: Array<{ operation: string; stage?: string | null; message: string }> = [];

    const report = await drainScopePlatformRequests(
      client,
      ctx,
      { 'connector:scrive': connectorDispatchHandler({ host, connector }) },
      { recordFailure: (e) => failures.push(e) },
    );

    expect(report).toEqual({ drained: 1, done: 0, failed: 1, pending: 0 });
    expect(settled[0]!.status).toBe('failed');
    // The provider's own sentence survives into the journal — the whole diagnosis, not "HTTP 409".
    expect(settled[0]!.lastError).toMatch(/requires valid personal number field/);
    expect(settled[0]!.lastError).toMatch(/not retried/);
    // …and a terminal settle is an operator's headline, not a spine-table archaeology find.
    expect(failures).toEqual([
      expect.objectContaining({ operation: 'intent.connector:scrive', stage: 'terminal' }),
    ]);
  });

  /**
   * #841, end to end and in the shape it actually happened: the connector's call back into the
   * VERTICAL is refused by our own permission check, arrives as a `ControlPlaneError`, and the
   * delivery was journaled as "a client error the provider will refuse identically on retry".
   * Scrive never saw the request. The operator audited their Scrive account and pressed **Test
   * connection**, which passed, because the credential was fine all along.
   */
  it('attributes a refusal raised on OUR side of egress to the platform, never to the provider', async () => {
    const req = intent('connector:scrive', { payload: { executorId: 'scrive', event: routedEvent() } });
    const { client, settled } = fakeTransport([req]);
    const { host, dispatched } = recordingHost();
    // What `dispatchConnector` really throws when the vertical refuses `openAttachment`.
    host.dispatchConnector = async () => {
      throw new ControlPlaneError(403, 'permission denied: protocol:read');
    };

    const report = await drainScopePlatformRequests(client, ctx, {
      'connector:scrive': connectorDispatchHandler({ host, connector }),
    });

    // Still terminal — a refused check refuses the retry identically. That was never the bug.
    expect(report).toEqual({ drained: 1, done: 0, failed: 1, pending: 0 });
    expect(dispatched).toEqual([]); // nothing was ever sent

    // The attribution is a VALUE now, not a sentence a reader has to parse.
    expect(settled[0]!.failure).toEqual({
      origin: 'platform',
      code: null,
      permission: 'protocol:read',
    });

    // …and the sentence beside it names us, clears the credential, and does not blame scrive.
    expect(settled[0]!.lastError).toMatch(/permission denied: protocol:read/);
    expect(settled[0]!.lastError).toMatch(/refused by this platform/);
    expect(settled[0]!.lastError).toMatch(/scrive never saw this request/);
    expect(settled[0]!.lastError).not.toMatch(/will refuse identically/);
  });

  it("still attributes a real provider refusal to the provider, and quotes it as their answer", async () => {
    const req = intent('connector:scrive', { payload: { executorId: 'scrive', event: routedEvent() } });
    const { client, settled } = fakeTransport([req]);
    const { host } = recordingHost('scrive start failed: HTTP 409 requires valid personal number field', 409);

    await drainScopePlatformRequests(client, ctx, {
      'connector:scrive': connectorDispatchHandler({ host, connector }),
    });

    expect(settled[0]!.failure).toEqual({ origin: 'provider', code: null, permission: null });
    expect(settled[0]!.lastError).toMatch(/scrive will refuse identically on retry/);
  });

  it('keeps a 5xx, a timeout and a rate limit retryable — those say nothing about the request', async () => {
    for (const status of [500, 502, 408, 429]) {
      const req = intent('connector:scrive', { payload: { executorId: 'scrive', event: routedEvent() } });
      const { client, settled } = fakeTransport([req]);
      const { host } = recordingHost(`scrive start failed: HTTP ${status}`, status);
      const report = await drainScopePlatformRequests(client, ctx, {
        'connector:scrive': connectorDispatchHandler({ host, connector }),
      });
      expect({ status, pending: report.pending }).toEqual({ status, pending: 1 });
      expect(settled[0]!.status).toBe('pending');
    }
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
    // The capability is a staff GRANT on the registry row (#444), not deployment config.
    await host.admin.setVerticalTenantProvisioner(staff, 'manager-console', true);
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
    // Provenance (#412): the customer tenant is stamped with the MANAGER's tenant id
    // (from ctx, host-derived), so the fleet can tell it from a direct staff create.
    const created = (await host.admin.listTenants(staff)).find((t) => t.id === newTenant);
    expect(created?.provisionedByTenant).toBe(managerTenant);
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
    // Unregistered entirely…
    const outcome = await provisionTenantHandler(deps())(
      { ...ctx, vertical: 'some-other-vertical' },
      intent('provision-tenant', { payload: payloadFor(ulid(), ulid()) }),
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/tenant-provisioner capability/);

    // …and registered but UNGRANTED: registration (a push) is not the grant. With no
    // declared `provisions` either, the refusal points at the manifest fix (#455).
    await host.admin.registerVertical(staff, { slug: 'pushed-console', name: 'Pushed', source: 'cli' });
    const ungranted = await provisionTenantHandler(deps())(
      { ...ctx, vertical: 'pushed-console' },
      intent('provision-tenant', { payload: payloadFor(ulid(), ulid()) }),
    );
    expect(ungranted.status).toBe('failed');
    expect(ungranted.error).toMatch(/tenant-provisioner capability/);
    expect(ungranted.error).toMatch(/declares no `provisions`/);
  });

  it('distinguishes declared-but-ungranted (#455): the request awaits the staff grant', async () => {
    await host.admin.registerVertical(staff, {
      slug: 'requested-console',
      name: 'Requested',
      source: 'cli',
      provisions: ['managed-product'],
    });
    const outcome = await provisionTenantHandler(deps())(
      { ...ctx, vertical: 'requested-console' },
      intent('provision-tenant', { payload: payloadFor(ulid(), ulid()) }),
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/declares provisions \[managed-product\] but the tenant-provisioner capability has not been granted/);
  });

  it('bounds a granted manager to its DECLARED targets (#412 invariant 4) — and only when it declares', async () => {
    await host.admin.registerVertical(staff, {
      slug: 'bounded-console',
      name: 'Bounded',
      source: 'cli',
      entitlements: ['flows'],
      provisions: ['managed-product'],
    });
    await host.admin.setVerticalTenantProvisioner(staff, 'bounded-console', true);

    // A payload naming a vertical OUTSIDE the declaration settles failed, naming both sides.
    const outside = payloadFor(ulid(), ulid());
    outside.instance.vertical = 'some-other-product';
    const refused = await provisionTenantHandler(deps())(
      { ...ctx, vertical: 'bounded-console' },
      intent('provision-tenant', { payload: outside }),
    );
    expect(refused.status).toBe('failed');
    expect(refused.error).toMatch(/does not include the payload's vertical 'some-other-product'/);

    // A declared target passes the bound end-to-end.
    const inside = payloadFor(ulid(), ulid());
    inside.tenant.slug = `bounded-${inside.tenant.id.slice(-8).toLowerCase()}`;
    const admitted = await provisionTenantHandler(deps())(
      { ...ctx, vertical: 'bounded-console' },
      intent('provision-tenant', { payload: inside }),
    );
    expect(admitted.status).toBe('done');
    // The suite's main manager ('manager-console') declares nothing and stays UNBOUNDED —
    // the pre-declaration behavior every other test in this file exercises.
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

  it('adopts a still-provisioning scope onto the serving script between passes (#570)', async () => {
    // The acme incident in miniature: the first pass runs while the scope has no serving
    // pointer to inherit, so its client resolves via the pinned version's script — and the
    // vertical refuses (its tenant store is bound to the SERVING script, not that one).
    const vId = ulid();
    await host.admin.registerVertical(staff, { slug: 'managed-product', name: 'Managed', source: 'cli' });
    await host.admin.publishVersion(staff, {
      id: vId,
      verticalSlug: 'managed-product',
      version: '1.0.0',
      manifestDigest: 'm',
      permissionDigest: 'p',
      migrationDigest: 'g',
      deploymentRef: 'managed-product-v1',
    });
    await host.admin.admitVersion(staff, vId);

    const newTenant = ulid();
    const newScope = ulid();
    const refusing = {
      ...deps(),
      resolveVerticalForScope: async () =>
        ({
          provisionInstance: async () => {
            throw new ControlPlaneError(503, 'no tenant store attached — provision first');
          },
        }) as unknown as VerticalClient,
    };
    const first = await provisionTenantHandler(refusing)(
      ctx,
      intent('provision-tenant', { payload: payloadFor(newTenant, newScope) }),
    );
    expect(first.status).toBe('pending'); // transient by the handler's contract — retried
    const stranded = await host.admin.getScopeRecord(staff, tenantId.parse(newTenant), scopeId.parse(newScope));
    expect(stranded?.servingRef ?? null).toBeNull();

    // The vertical now serves in place. The retry must stamp the scope's serving pointer
    // BEFORE resolving the client, so provisioning, the store-binding patch, and the
    // router all target the one serving script — the #570 convergence.
    await host.admin.setVerticalServing(staff, 'managed-product', {
      ref: 'managed-product-serving',
      versionId: vId,
      doClasses: [],
      migrationTag: 'g',
    });
    let resolvedWith: { servingRef?: string | null } | undefined;
    const capture = {
      ...deps(),
      resolveVerticalForScope: async (scope: { servingRef?: string | null }) => {
        resolvedWith = scope;
        return fakeVertical;
      },
    };
    const retry = await provisionTenantHandler(capture)(
      ctx,
      intent('provision-tenant', { payload: payloadFor(newTenant, newScope) }),
    );
    expect(retry.status).toBe('done');
    expect(resolvedWith?.servingRef).toBe('managed-product-serving');
    const adopted = await host.admin.getScopeRecord(staff, tenantId.parse(newTenant), scopeId.parse(newScope));
    expect(adopted?.servingRef).toBe('managed-product-serving');
    expect(adopted?.verticalVersionId).toBe(vId);
    expect(adopted?.status).toBe('active');
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
    await host.admin.setVerticalTenantProvisioner(staff, 'manager-console', true);
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
