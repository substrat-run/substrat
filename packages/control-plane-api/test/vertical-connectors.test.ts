import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { assertAllowed, runPlatformSweep, ulid, undeclaredOperations, webCryptoSecretBox, type FetchLike, type ModuleRegistration, type OperationHandler } from '@substrat-run/kernel';
import {
  connectionId,
  moduleManifest,
  permissionKey,
  platformActorId,
  platformRequestId,
  principalId,
  scopeId,
  tenantId,
  verticalConnectorBindingKey,
  verticalConnectorDeclaration,
  verticalConnectorStateKey,
  type Connection,
  type ConnectorCallRequest,
  type PlatformRequest,
  type PlatformRequestEntry,
  type ScopeId,
  type VerticalConnectorDeclaration,
} from '@substrat-run/contracts';
import {
  createControlPlaneApi,
  DEV_ACTOR_HEADER,
  drainScopePlatformRequests,
  relayConnectionUpsert,
  resolveVerticalConnectorTarget,
  UNSAFE_devPlatformActorAuth,
  verticalConnectorReadsOf,
  verticalConnectorBinder,
  verticalConnectorInspector,
  verticalConnectorSweeper,
  verticalConnectorDispatchHandler,
  type ConnectionInspector,
  type VerticalClient,
  type VerticalConnectorDeps,
  type VerticalConnectorReads,
  type VerticalConnectorTarget,
} from '../src/index.js';
import { heldVersion } from './held-manifest.js';

/**
 * Vertical-defined connectors, the platform side (docs/architecture/vertical-connectors.md §6): the
 * platform keeps the credential, the bindings, the state and the health, and runs the provider code
 * by calling into the vertical. `resolve` and `call` are fakes here — the call records what crossed
 * and answers what each case scripts — so what is held is what the platform sends and applies.
 */
describe('vertical-defined connectors — the platform side', () => {
  const PROVIDER = 'acme.box';
  const SLUG = 'acme-docs';
  const LAND = permissionKey.parse('docs:land');
  const NOW = '2026-06-15T12:00:00.000Z';
  const FETCH = (() => Promise.reject(new Error('unused'))) as unknown as FetchLike;

  let dir: string;
  let host: SqliteScopeHost;
  let staff = platformActorId.parse(ulid());
  let t = tenantId.parse(ulid());
  let a: ScopeId;
  let b: ScopeId;
  let row: Connection;
  let declaration: VerticalConnectorDeclaration;
  let calls: { target: VerticalConnectorTarget; request: ConnectorCallRequest }[];
  let answer: (request: ConnectorCallRequest, target: VerticalConnectorTarget) => Promise<{ status: number; body: unknown }>;

  const docs: ModuleRegistration = {
    manifest: moduleManifest.parse({
      id: '@acme/docs',
      version: '1.0.0',
      kernelContract: '^0.0.1',
      permissions: [{ key: 'docs:land', description: 'land a document' }, { key: 'docs:extra', description: 'more than landing' }],
      events: { emits: [], consumes: [] },
      migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
      attachmentTargets: [],
      entitlementKey: 'docs',
    }),
    ...undeclaredOperations('a test fixture standing in for the landing operation', {
      'docs/land': (async (ctx) => {
        assertAllowed(await ctx.check(LAND));
        return { ok: true };
      }) as OperationHandler<never, unknown>,
    }),
  };

  const declare = (over: Partial<VerticalConnectorDeclaration> = {}) =>
    verticalConnectorDeclaration.parse({
      provider: PROVIDER,
      label: 'Box',
      description: 'A document box.',
      fields: [{ key: 'token', label: 'Token', secret: true }],
      grants: [],
      events: ['docs.requested'],
      sweeps: true,
      binds: false,
      dispatches: true,
      ...over,
    });
  const deps = (): VerticalConnectorDeps => ({
    host,
    actor: staff,
    now: () => NOW,
    resolve: async ({ scopeId: scope }) => ({
      declaration,
      target: { deploymentRef: `ref-${scope ?? 'serving'}`, slug: SLUG, tenantId: t, scopeId: scope, hosts: ['box.example'] },
    }),
    call: async (target, request) => {
      calls.push({ target, request });
      return answer(request, target);
    },
  });
  const ok = (over: Record<string, unknown> = {}) => ({ status: 200, body: { ok: true, result: null, state: [], uses: [], ...over } });
  const bind = (scope: ScopeId) =>
    host.admin.putConnectorState(row.id, verticalConnectorBindingKey(scope), { scopeId: scope, operation: 'docs/land', permission: LAND, options: {}, declared: {}, boundAt: NOW });
  const stateAt = (scope: string | null, key: string) => host.admin.getConnectorState(row.id, verticalConnectorStateKey(scope, key));

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vertical-connectors-'));
    staff = platformActorId.parse(ulid());
    t = tenantId.parse(ulid());
    a = scopeId.parse(ulid());
    b = scopeId.parse(ulid());
    calls = [];
    declaration = declare();
    answer = async () => ok();
    host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('k', new Uint8Array(32).fill(7)) });
    host.registerModule(docs);
    await host.admin.createTenant(staff, { id: t, slug: 'acme', name: 'Acme' });
    await host.admin.grantEntitlement(staff, t, 'docs');
    await host.admin.registerVertical(staff, { slug: SLUG, name: 'Acme Docs', source: 'builtin' });
    for (const s of [a, b]) {
      await host.provisionScope(staff, { tenantId: t, scopeId: s, jurisdiction: 'eu', vertical: SLUG });
      await host.admin.activateScope(staff, t, s);
    }
    const id = connectionId.parse(ulid());
    await host.admin.createConnection(staff, { id, tenantId: t, vertical: SLUG, provider: PROVIDER, label: 'Box', scopes: [], secret: { token: 't0k' } });
    await host.admin.grantToConnection(staff, { connectionId: id, permission: LAND, node: { tenantId: t, scopeId: a }, grantedBy: staff });
    row = (await host.admin.listConnections(staff, { tenantId: t }))[0]!;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("sweeps each binding into its own scope's deployment with only that scope's state, and applies only what succeeded", async () => {
    await bind(a);
    await bind(b);
    await host.admin.putConnectorState(row.id, verticalConnectorStateKey(a, 'cursor'), 'a1');
    await host.admin.putConnectorState(row.id, verticalConnectorStateKey(b, 'cursor'), 'b1');
    const uses = vi.spyOn(host.admin, 'recordConnectionUse');
    answer = async (_request, target) =>
      target.scopeId === a
        ? ok({ result: { landed: 3, more: false }, state: [{ key: 'cursor', value: 'a2' }, { key: 'seen', value: null }], uses: [{ ok: true, status: 200 }] })
        : { status: 200, body: { ok: false, refused: false, error: 'box answered 503', uses: [{ ok: false, error: 'box answered 503', status: 503 }] } };

    const result = await verticalConnectorSweeper(deps(), row)(host, row.id, { fetch: FETCH });

    expect(result).toEqual({ found: 2, failed: [{ scopeId: b, error: 'box answered 503' }], landed: 3 });
    const byScope = new Map(calls.map((c) => [c.target.scopeId, c]));
    expect(byScope.get(a)!.target.deploymentRef).toBe(`ref-${a}`);
    expect(byScope.get(a)!.request).toMatchObject({ role: 'sweep', binding: { scopeId: a }, state: [{ key: 'cursor', value: 'a1' }], connection: { id: row.id, secret: { token: 't0k' } } });
    expect(byScope.get(b)!.request).toMatchObject({ role: 'sweep', binding: { scopeId: b }, state: [{ key: 'cursor', value: 'b1' }] });
    expect(await stateAt(a, 'cursor')).toBe('a2');
    expect(await stateAt(b, 'cursor')).toBe('b1'); // the failed call's scope keeps its cursor
    expect(uses.mock.calls.map(([, use]) => use)).toEqual(expect.arrayContaining([{ ok: true, status: 200 }, { ok: false, error: 'box answered 503', status: 503 }]));
    expect(uses).toHaveBeenCalledTimes(2);
  });

  it('records one failed use when the call never answers, and applies a probe that did', async () => {
    const uses = vi.spyOn(host.admin, 'recordConnectionUse');
    const inspector = verticalConnectorInspector(deps(), PROVIDER, { tenantId: t, vertical: SLUG, scopeId: null });
    answer = async () => {
      throw new Error('router unreachable');
    };
    expect(await inspector.probe(host, row)).toMatchObject({ ok: false, refused: false, error: expect.stringContaining('router unreachable') });
    answer = async () => ({ status: 502, body: 'bad gateway' });
    expect(await inspector.probe(host, row)).toMatchObject({ ok: false, refused: false, error: "the vertical's connector answered HTTP 502" });
    expect(uses.mock.calls.map(([, use]) => use.ok)).toEqual([false, false]);

    const probe = { ok: true, refused: false, accountRef: 'acct-1', accountLabel: 'Acme AB', facts: [], error: null };
    answer = async () => ok({ result: probe, state: [{ key: 'token-age', value: 3 }], uses: [{ ok: true }] });
    expect(await inspector.probe(host, row)).toEqual(probe);
    expect(calls.at(-1)!.target.scopeId).toBeNull();
    expect(await stateAt(null, 'token-age')).toBe(3);
    expect(uses.mock.calls.at(-1)![1]).toEqual({ ok: true });
  });

  it('refuses to send a credential when the live connection is not the row the call is for', async () => {
    const other = { ...row, id: connectionId.parse(ulid()) };
    const inspector = verticalConnectorInspector(deps(), PROVIDER, { tenantId: t, vertical: SLUG, scopeId: null });
    expect(await inspector.probe(host, other)).toMatchObject({ ok: false, error: expect.stringMatching(/is not the live 'acme\.box' connection/) });
    expect(calls).toEqual([]);
  });

  it('binds only a connection holding the key, storing the options its connector normalised', async () => {
    const binder = verticalConnectorBinder(deps());
    const target = { tenantId: t, scopeId: b, vertical: SLUG, operation: 'docs/land', permission: LAND, folder: 'Inbox' };
    await expect(binder.bind(host, row, target)).rejects.toThrow(/does not hold 'docs:land' on scope/);
    await expect(binder.bind(host, row, { ...target, scopeId: a })).rejects.toThrow(/takes no binding options/);
    expect(calls).toEqual([]);

    declaration = declare({ binds: true });
    answer = async () => ok({ result: { options: { folderId: 'F1' } } });
    await binder.bind(host, row, { ...target, scopeId: a });

    expect(calls[0]!.request).toMatchObject({ role: 'bind', scopeId: a, options: { folder: 'Inbox' } });
    expect(await host.admin.getConnectorState(row.id, verticalConnectorBindingKey(a))).toEqual({
      scopeId: a, operation: 'docs/land', permission: LAND, options: { folderId: 'F1' }, declared: { folder: 'Inbox' }, boundAt: NOW,
    });
    // The pass compares a declaration with what was declared, not with what the hook made of it.
    expect(await binder.list(host, row)).toEqual([{ folder: 'Inbox', scopeId: a, operation: 'docs/land', permission: LAND }]);

    // #2732: and the inspector's unbind drops it, again harmlessly.
    const { unbindScope } = verticalConnectorInspector(deps(), row.provider, { tenantId: t, vertical: SLUG, scopeId: a });
    await unbindScope(host, row, a);
    await unbindScope(host, row, a);
    expect(await binder.list(host, row)).toEqual([]);
  });

  it('binds a declared landing once through the kernel’s fallbacks, though its bind hook rewrites the option, and sweeps it every pass', async () => {
    const versionId = ulid();
    await host.admin.publishVersion(
      staff,
      await heldVersion({
        id: versionId, verticalSlug: SLUG, version: `1.0.${versionId.toLowerCase()}`, manifestDigest: `m-${versionId}`,
        permissionDigest: 'p', migrationDigest: 'g', deploymentRef: null,
        manifestJson: JSON.stringify({
          registry: {
            permissions: [{ key: 'docs:land', description: 'land a document', declaredBy: ['@acme/docs'] }],
            roles: [],
            entityGrants: [],
            connections: [{ provider: PROVIDER, operation: 'docs/land', permission: 'docs:land', options: { folder: 'Inbox' }, declaredBy: ['@acme/docs'] }],
          },
        }),
      }),
    );
    await host.admin.admitVersion(staff, versionId);
    await host.admin.bindScopeVersion(staff, t, b, versionId);
    declaration = declare({ binds: true });
    answer = async (request) => (request.role === 'bind' ? ok({ result: { options: { folder: 'F1' } } }) : ok({ result: { landed: 1, more: false } }));
    const pass = () =>
      runPlatformSweep(host, {
        actor: staff,
        fetch: FETCH,
        sweepers: {},
        sweeperFor: (c) => verticalConnectorSweeper(deps(), c),
        drainRetries: false,
        connectionLandings: { read: (slug, id) => host.versionConnectionLandings(slug, id), binders: {}, binderFor: () => verticalConnectorBinder(deps()) },
      });
    const bindAudits = async () => (await host.admin.auditLog(staff, {})).filter((e) => e.action === 'bindConnectionScope').length;

    const first = await pass();

    expect(first.connectionLandings).toEqual({ granted: 1, bound: 1, failed: 0 });
    expect(await host.admin.getConnectorState(row.id, verticalConnectorBindingKey(b))).toMatchObject({ scopeId: b, options: { folder: 'F1' }, declared: { folder: 'Inbox' } });
    expect(calls.map((c) => [c.request.role, c.target.scopeId])).toEqual([['bind', b], ['sweep', b]]);
    expect(first.connectionsSwept).toBe(1);
    expect(await bindAudits()).toBe(1);

    calls = [];
    const second = await pass();

    expect(second.connectionLandings).toEqual({ granted: 0, bound: 0, failed: 0 });
    expect(calls.map((c) => c.request.role)).toEqual(['sweep']);
    expect(await bindAudits()).toBe(1);
  });

  it("refuses a sweep whose writes would take the scope's state past the cap, writing none of them", async () => {
    await bind(a);
    let n = 0;
    answer = async () => {
      n += 1;
      return ok({ result: { landed: 0, more: true }, state: Array.from({ length: 1500 }, (_, i) => ({ key: `p${n}-${i}`, value: i })) });
    };
    const sweep = () => verticalConnectorSweeper(deps(), row)(host, row.id, { fetch: FETCH });
    expect(await sweep()).toEqual({ found: 1, failed: [], landed: 0 });

    const second = await sweep();

    expect(second.failed).toEqual([{ scopeId: a, error: expect.stringMatching(/^connector state would exceed .* with 3000 keys: nothing was written; the connector must delete keys$/) }]);
    const stored = (await host.admin.listConnectorState(row.id, verticalConnectorStateKey(a, ''))).map((r) => r.key);
    expect(stored).toHaveLength(1500);
    expect(stored.every((k) => k.startsWith(verticalConnectorStateKey(a, 'p1-')))).toBe(true);

    // A connector that deletes what it no longer needs runs again: its deletes count toward the fit.
    answer = async () =>
      ok({
        result: { landed: 0, more: false },
        state: [...Array.from({ length: 1000 }, (_, i) => ({ key: `p1-${i}`, value: null })), ...Array.from({ length: 900 }, (_, i) => ({ key: `p3-${i}`, value: i }))],
      });
    expect((await sweep()).failed).toEqual([]);
    expect((await host.admin.listConnectorState(row.id, verticalConnectorStateKey(a, ''))).filter((r) => r.value !== null)).toHaveLength(1400);
  });

  it('answers a probe that cannot run as a probe, without calling, when the stored state is over the cap', async () => {
    const big = 'x'.repeat(300 * 1024);
    await host.admin.putConnectorState(row.id, verticalConnectorStateKey(null, 'one'), big);
    await host.admin.putConnectorState(row.id, verticalConnectorStateKey(null, 'two'), big);
    const inspector = verticalConnectorInspector(deps(), PROVIDER, { tenantId: t, vertical: SLUG, scopeId: null });
    expect(await inspector.probe(host, row)).toMatchObject({ ok: false, refused: false, error: expect.stringMatching(/^the probe could not run: the connector state of the connection does not fit one call/) });
    expect(calls).toEqual([]);
  });

  it("grants a connection exactly what its vertical's serving version declares, whatever the caller asks", async () => {
    const version = async (grants: string[]) => {
      const id = ulid();
      await host.admin.publishVersion(
        staff,
        await heldVersion({
          id, verticalSlug: SLUG, version: `1.0.${id.toLowerCase()}`, manifestDigest: `m-${id}`,
          permissionDigest: 'p', migrationDigest: 'g', deploymentRef: `script-${id.toLowerCase()}`,
          manifestJson: JSON.stringify({ connectors: [declare({ grants, events: [], dispatches: false })] }),
        }),
      );
      await host.admin.admitVersion(staff, id);
      return id;
    };
    const declarationOf = (provider: string, context: { tenantId: typeof t; vertical: string }) =>
      resolveVerticalConnectorTarget(verticalConnectorReadsOf(host, staff), { ...context, scopeId: null, provider });
    const upsert = (provider: string) =>
      relayConnectionUpsert(
        host,
        staff,
        { tenantId: t, scopeId: b, provider, secret: { token: 'new' }, grants: ['docs:land', 'docs:extra'], createdBy: 'someone' },
        { declarationOf },
      );
    const held = async () => (await host.connectionGrantsInScope(t, b)).filter((g) => g.connectionId === row.id).map((g) => g.permission).sort();
    const v1 = await version(['docs:land']);
    await host.admin.promoteVersion(staff, SLUG, 'prod', v1);

    expect((await upsert(PROVIDER)).granted).toEqual(['docs:land']);
    expect(await held()).toEqual(['docs:land']);
    // A push that widens the grants takes effect only once its version serves.
    const v2 = await version(['docs:land', 'docs:extra']);
    await upsert(PROVIDER);
    expect(await held()).toEqual(['docs:land']);
    await host.admin.promoteVersion(staff, SLUG, 'prod', v2);
    expect((await upsert(PROVIDER)).granted).toEqual(['docs:land', 'docs:extra']);
    expect(await held()).toEqual(['docs:extra', 'docs:land']);

    // A host that resolves no declaration grants nothing it cannot read.
    await expect(
      relayConnectionUpsert(host, staff, { tenantId: t, scopeId: b, provider: PROVIDER, secret: { token: 'x' }, grants: ['docs:extra'], createdBy: 'someone' }),
    ).rejects.toMatchObject({ status: 503 });
    await expect(upsert('acme.other')).rejects.toMatchObject({ status: 409, message: `version ${v2} of '${SLUG}' does not declare the connector 'acme.other'` });
    expect(await host.admin.listConnections(staff, { tenantId: t, provider: 'acme.other' })).toEqual([]);
  });

  describe('a routed event, drained', () => {
    const INSTALL = { kind: 'app', forkedFrom: null };
    const LIVE = { scope: 'active', tenant: 'active' } as const;
    const event = (marker: string, over: Record<string, unknown> = {}) => ({
      id: ulid(),
      type: 'docs.requested',
      schemaVersion: 1,
      occurredAt: NOW,
      tenantId: t,
      scopeId: a,
      actor: { system: 'docs' },
      entity: { entityType: 'doc', entityId: ulid() },
      piiClass: 'none',
      payload: { marker },
      ...over,
    });
    const intent = (kind: string, payload: unknown): PlatformRequest => ({
      id: platformRequestId.parse(ulid()),
      kind,
      payload,
      requestedBy: principalId.parse(ulid()),
      status: 'pending',
      attempts: 0,
      lastError: null,
      result: null,
      requestedAt: NOW as PlatformRequest['requestedAt'],
      settledAt: null,
    });
    const drain = async (pending: PlatformRequestEntry[], withHook: boolean, scope: ScopeId = a) => {
      const settled = new Map<string, { status: string; lastError?: string | null }>();
      const client = {
        listPlatformRequests: async () => pending,
        settlePlatformRequest: async (_t: unknown, _s: unknown, id: string, o: { status: string; lastError?: string | null }) => void settled.set(id, o),
      } as unknown as Pick<VerticalClient, 'listPlatformRequests' | 'settlePlatformRequest'>;
      const handler = verticalConnectorDispatchHandler(deps());
      await drainScopePlatformRequests(
        client,
        { tenantId: t, scopeId: scope, vertical: SLUG, scope: INSTALL, lifecycle: LIVE },
        { 'connector:scrive': async () => ({ status: 'done' }) },
        withHook ? { handlerFor: (kind) => (kind.startsWith('connector:') && kind.includes('.') ? handler : undefined) } : {},
      );
      return settled;
    };

    it('settles a delivery done, a refusal failed, a retryable failure pending, and refuses a forged stamp', async () => {
      await bind(a);
      await host.admin.putConnectorState(row.id, verticalConnectorStateKey(a, 'n'), 1);
      answer = async (request) => {
        const marker = request.role === 'dispatch' ? (request.event.payload as { marker: string }).marker : '';
        if (marker === 'ok') return ok({ state: [{ key: 'n', value: 2 }] });
        return { status: 200, body: { ok: false, refused: marker === 'refuse', error: `box said no (${marker})`, uses: [] } };
      };
      const kind = `connector:${PROVIDER}`;
      const delivered = intent(kind, { executorId: PROVIDER, event: event('ok') });
      const refused = intent(kind, { executorId: PROVIDER, event: event('refuse') });
      const retry = intent(kind, { executorId: PROVIDER, event: event('retry') });
      const forged = intent(kind, { executorId: PROVIDER, event: event('ok', { scopeId: b }) });
      const firstParty = intent('connector:scrive', {});

      const settled = await drain([delivered, refused, retry, forged, firstParty], true);

      expect(settled.get(delivered.id)).toMatchObject({ status: 'done' });
      expect(settled.get(refused.id)).toMatchObject({ status: 'failed', lastError: expect.stringContaining('box said no (refuse)') });
      expect(settled.get(retry.id)).toMatchObject({ status: 'pending', lastError: 'box said no (retry)' });
      expect(settled.get(forged.id)).toMatchObject({ status: 'failed', lastError: expect.stringMatching(/is not the drained scope/) });
      expect(settled.get(firstParty.id)).toMatchObject({ status: 'done' }); // the record still wins
      expect(calls).toHaveLength(3);
      expect(calls[0]!.request).toMatchObject({ role: 'dispatch', scopeId: a, binding: { scopeId: a }, state: [{ key: 'n', value: 1 }] });
      expect(await stateAt(a, 'n')).toBe(2);

      // Without the hook, a dotted kind is an unknown kind, as before.
      const bare = await drain([intent(kind, { executorId: PROVIDER, event: event('ok') })], false);
      expect([...bare.values()]).toEqual([expect.objectContaining({ status: 'failed', lastError: `no handler for platform-request kind '${kind}'` })]);
    });

    it("hands a scope's event its own connection once that is bound there, else the tenant's, never another scope's (#2732)", async () => {
      await bind(a);
      const ofA = connectionId.parse(ulid());
      await host.admin.createConnection(staff, {
        id: ofA, tenantId: t, vertical: SLUG, provider: PROVIDER, label: 'own', secret: { password: 'own' }, ownerScopeId: a,
      });
      answer = async () => ok({});
      const kind = `connector:${PROVIDER}`;
      const dispatchFrom = (s: ScopeId) => drain([intent(kind, { executorId: PROVIDER, event: event('ok', { scopeId: s }) })], true, s);

      // A's own connection, not bound on A, does not shadow the tenant's bound one.
      await dispatchFrom(a);
      await host.admin.putConnectorState(ofA, verticalConnectorBindingKey(a), { scopeId: a, operation: 'docs/land', permission: LAND, options: {}, declared: {}, boundAt: NOW });
      await dispatchFrom(a);
      await dispatchFrom(b);

      expect(calls.map((c) => (c.request as { connection: { id: string } }).connection.id)).toEqual([row.id, ofA, row.id]);
    });
  });

  it('routes a dotted provider’s inspection to the fallback, the record first, and 501s without either', async () => {
    const fallback: ConnectionInspector = {
      probe: async () => ({ ok: true, refused: false, accountRef: 'from-fallback', accountLabel: null, facts: [], error: null }),
      probeCandidate: async () => ({ ok: false, refused: true, accountRef: null, accountLabel: null, facts: [], error: 'fallback refused it' }),
      bindScope: async (_h, _row, target) => ({ ...target, boundAt: NOW }),
    };
    const contexts: unknown[] = [];
    const app = (connectionInspectors?: Record<string, ConnectionInspector>, withHook = true) =>
      createControlPlaneApi({
        host,
        authenticate: UNSAFE_devPlatformActorAuth(),
        ...(connectionInspectors ? { connectionInspectors } : {}),
        ...(withHook ? { verticalConnectorInspector: (_provider: string, context: unknown) => (contexts.push(context), fallback) } : {}),
        verticalConnectorDeclaration: async () => ({ declaration: { grants: [] } }),
      });
    const req = (api: ReturnType<typeof app>, path: string, method: string, body?: unknown) =>
      api.request(path, { method, headers: { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const verify = `/tenants/${t}/connections/${row.id}/verify`;

    expect(await (await req(app(), verify, 'POST')).json()).toMatchObject({ accountRef: 'from-fallback' });
    expect(contexts).toEqual([{ tenantId: t, vertical: SLUG, scopeId: null }]);
    const record = { probe: async () => ({ ok: true, refused: false, accountRef: 'from-record', accountLabel: null, facts: [], error: null }) };
    expect(await (await req(app({ [PROVIDER]: record }), verify, 'POST')).json()).toMatchObject({ accountRef: 'from-record' });
    expect((await req(app(undefined, false), verify, 'POST')).status).toBe(501);

    // The staff binding door passes a dotted provider's options through to its connector.
    const bound = await req(app(), `/tenants/${t}/connections/${row.id}/bindings/${a}`, 'PUT', { operation: 'docs/land', permission: LAND, folder: 'Inbox' });
    expect(bound.status).toBe(200);
    expect(await bound.json()).toMatchObject({ folder: 'Inbox', scopeId: a });

    // The connect-time gate asks the fallback, with the vertical this directory derived.
    contexts.length = 0;
    const created = await req(app(), `/tenants/${t}/connections`, 'POST', { scopeId: b, provider: PROVIDER, secret: { token: 'new' }, createdBy: 'someone' });
    expect(created.status).toBe(422);
    expect(contexts).toEqual([{ tenantId: t, vertical: SLUG, scopeId: b }]);
  });
});

/**
 * Which version's declaration a call runs and which deployment it goes to (§6.3, §6.4), decided
 * from directory and registry records alone — the reads are plain values here.
 */
describe('resolveVerticalConnectorTarget', () => {
  const T = tenantId.parse(ulid());
  const S = scopeId.parse(ulid());
  const SLUG = 'acme-docs';
  const declared = (provider: string) =>
    verticalConnectorDeclaration.parse({
      provider, label: 'Box', description: '', fields: [{ key: 'token', label: 'Token', secret: true }],
      grants: [], events: [], sweeps: true, binds: false, dispatches: false,
    });
  /** v1 (the scope's pin) declares the connector, v2 (served, prod) too, v3 does not. */
  const reads = (over: { scope?: Record<string, unknown> | null; serving?: { ref: string; versionId: string } | null; prod?: string | null } = {}): VerticalConnectorReads => ({
    scope: async () => (over.scope === null ? undefined : ({ vertical: SLUG, kind: 'app', forkedFrom: null, verticalVersionId: 'v1', servingRef: null, ...over.scope } as never)),
    serving: async () => (over.serving === undefined ? { ref: 'serving-script', versionId: 'v2' } : over.serving),
    prodVersionId: async () => (over.prod === undefined ? 'v2' : over.prod),
    version: async (_slug, id) => ({ v1: { deploymentRef: 'script-v1', outbound: ['v1.example'] }, v2: { deploymentRef: 'script-v2', outbound: ['v2.example'] }, v3: { deploymentRef: 'script-v3', outbound: null } })[id as 'v1'],
    connectors: async (_slug, id) => (id === 'v3' ? { kind: 'none' } : { kind: 'connectors', rows: [declared('acme.box')] }),
  });
  const resolve = (r: VerticalConnectorReads, scope: ScopeId | null, provider = 'acme.box') =>
    resolveVerticalConnectorTarget(r, { tenantId: T, vertical: SLUG, scopeId: scope, provider });
  const target = async (r: VerticalConnectorReads, scope: ScopeId | null) => {
    const out = await resolve(r, scope);
    if ('refused' in out) throw new Error(out.refused);
    return out.target;
  };

  it("runs a scoped call in the scope's own running version, not the one the vertical serves", async () => {
    // Pinned to v1 on its version's own script, while the vertical serves v2.
    expect(await target(reads(), S)).toEqual({ deploymentRef: 'script-v1', slug: SLUG, tenantId: T, scopeId: S, hosts: ['v1.example'] });
    // On the serving script, it runs what that script runs, there.
    expect(await target(reads({ scope: { servingRef: 'serving-script' } }), S)).toEqual({ deploymentRef: 'serving-script', slug: SLUG, tenantId: T, scopeId: S, hosts: ['v2.example'] });
  });

  it('runs a connection-level call in the serving version, else the prod channel’s', async () => {
    expect(await target(reads(), null)).toMatchObject({ deploymentRef: 'serving-script', scopeId: null, hosts: ['v2.example'] });
    expect(await target(reads({ serving: null, prod: 'v1' }), null)).toMatchObject({ deploymentRef: 'script-v1', hosts: ['v1.example'] });
  });

  it('refuses a preview, a fork, a foreign scope, and a version that does not declare the provider', async () => {
    for (const scope of [{ kind: 'preview' }, { forkedFrom: ulid() }]) {
      expect(await resolve(reads({ scope }), S)).toEqual({ refused: `scope ${S} is a preview or a fork, and those cause no outbound effects` });
    }
    expect(await resolve(reads({ scope: { vertical: 'other' } }), S)).toMatchObject({ refused: expect.stringContaining('is not an install of') });
    expect(await resolve(reads({ scope: { verticalVersionId: 'v3' } }), S)).toEqual({ refused: `version v3 of '${SLUG}' does not declare the connector 'acme.box'` });
    expect(await resolve(reads(), S, 'acme.other')).toEqual({ refused: `version v1 of '${SLUG}' does not declare the connector 'acme.other'` });
  });
});
