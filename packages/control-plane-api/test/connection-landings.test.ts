import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import {
  assertAllowed,
  NO_BINDING,
  runPlatformSweep,
  ulid,
  undeclaredOperations,
  webCryptoSecretBox,
  type ConnectionBinder,
  type ConnectorSweeper,
  type FetchLike,
  type ModuleRegistration,
  type OperationHandler,
} from '@substrat-run/kernel';
import {
  connectionId,
  moduleManifest,
  permissionKey,
  platformActorId,
  scopeId,
  tenantId,
  type ConnectionId,
  type ScopeId,
  type SweepRunInput,
} from '@substrat-run/contracts';
import {
  FortnoxMock,
  bindFortnoxScope,
  listFortnoxBindings,
  sweepFortnoxLedger,
  type FortnoxLedgerPage,
} from '@substrat-run/connector-fortnox';
import {
  PlanimaMock,
  bindPlanimaScope,
  listPlanimaBindings,
  sweepPlanimaPlan,
  type PlanimaPlanPage,
} from '@substrat-run/connector-planima';
import { connectionBindingOptions } from '../src/index.js';
import { heldVersion } from './held-manifest.js';

/**
 * #2316: a vertical that DECLARES its connection landings gets them, with nobody running
 * `substrat connection bind` and no relay granting the key.
 *
 * The world is the one the issue describes: connections created the way the dashboard's door and a
 * connect link create them (the provider's registered grants, which are `[]` for both), so nothing
 * holds the vertical's landing key and nothing is bound. One connector pass must then grant the
 * declared key, bind every connection of the provider, and land pages through the declared
 * operation, each connector against its own mock. The binders are built the way the control plane's
 * `connectionBindersFor` builds them: the connector's own bind and list, and the same options schema
 * the staff binding door validates with.
 */
describe('declared connection landings (#2316)', () => {
  const LEDGER_RECORD = permissionKey.parse('ledger:record');
  const PLAN_RECORD = permissionKey.parse('plan:record');
  const SLUG = 'acme-crm';
  const NOW = Date.parse('2026-06-15T12:00:00.000Z');

  let dir: string;
  let host: SqliteScopeHost;
  let fortnox: FortnoxMock;
  let planima: PlanimaMock;
  let staff = platformActorId.parse(ulid());
  let t = tenantId.parse(ulid());
  let s: ScopeId;
  let ledgerPages: FortnoxLedgerPage[];
  let planPages: PlanimaPlanPage[];
  let runs: SweepRunInput[];

  /** The vertical: two landing operations, each checking the key its declaration names. */
  const crm: ModuleRegistration = {
    manifest: moduleManifest.parse({
      id: '@acme/crm',
      version: '1.0.0',
      kernelContract: '^0.0.1',
      permissions: [
        { key: 'ledger:record', description: 'land a period of the ledger' },
        { key: 'plan:record', description: 'land a maintenance plan' },
      ],
      events: { emits: [], consumes: [] },
      migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
      attachmentTargets: [],
      entitlementKey: 'crm',
    }),
    ...undeclaredOperations('a test fixture standing in for the landing operations', {
      'ledger/record-period': (async (ctx, input: FortnoxLedgerPage) => {
        assertAllowed(await ctx.check(LEDGER_RECORD));
        ledgerPages.push(input);
        return { ok: true };
      }) as OperationHandler<never, unknown>,
      'maintenance/record-plan': (async (ctx, input: PlanimaPlanPage) => {
        assertAllowed(await ctx.check(PLAN_RECORD));
        planPages.push(input);
        return { ok: true };
      }) as OperationHandler<never, unknown>,
    }),
  };

  /** What `substrat push` stores: the registry `buildPermissionRegistry` would derive from the modules. */
  const manifestDeclaring = (connections: unknown[] | undefined) =>
    JSON.stringify({
      registry: {
        permissions: [
          { key: 'ledger:record', description: 'land a period of the ledger', declaredBy: ['@acme/crm'] },
          { key: 'plan:record', description: 'land a maintenance plan', declaredBy: ['@acme/crm'] },
        ],
        roles: [],
        entityGrants: [],
        ...(connections ? { connections } : {}),
      },
    });
  const DECLARED = [
    { provider: 'fortnox', operation: 'ledger/record-period', permission: 'ledger:record', declaredBy: ['@acme/crm'] },
    {
      provider: 'planima',
      operation: 'maintenance/record-plan',
      permission: 'plan:record',
      options: { organizationId: null, horizonYears: 50 },
      declaredBy: ['@acme/crm'],
    },
  ];

  const publish = async (manifestJson: string): Promise<string> => {
    const id = ulid();
    await host.admin.publishVersion(
      staff,
      await heldVersion({
        id,
        verticalSlug: SLUG,
        version: `1.0.${id.toLowerCase()}`,
        manifestDigest: `m-${id}`,
        permissionDigest: 'p',
        migrationDigest: 'g',
        deploymentRef: null,
        manifestJson,
      }),
    );
    await host.admin.admitVersion(staff, id);
    return id;
  };

  /** A connection as the dashboard's door or a connect link leaves it: the provider's grants, `[]`. */
  const connect = async (provider: 'fortnox' | 'planima', externalAccountRef?: string): Promise<ConnectionId> => {
    const id = connectionId.parse(ulid());
    await host.admin.createConnection(staff, {
      id,
      tenantId: t,
      vertical: SLUG,
      provider,
      label: `${provider} ${externalAccountRef ?? ''}`.trim(),
      ...(externalAccountRef ? { externalAccountRef } : {}),
      scopes: [],
      // The mock serves one company, so both Fortnox connections read the same books.
      secret: provider === 'fortnox' ? { clientId: 'client-id', clientSecret: 'client-secret', tenantId: '123456' } : { token: 'planima-test-token' },
    });
    return id;
  };

  const fetch: FetchLike = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    return url.startsWith(planima.apiBase) ? planima.fetch(input, init) : fortnox.fetch(input, init);
  };
  const sweepers: Record<string, ConnectorSweeper> = {
    fortnox: (h, id, o) => sweepFortnoxLedger(h, id, { ...o, apiBase: fortnox.apiBase, oauthBase: fortnox.oauthBase, now: () => NOW }),
    planima: (h, id, o) => sweepPlanimaPlan(h, id, { ...o, apiBase: planima.apiBase, now: () => NOW, sleep: async () => {} }),
  };
  /** `connectionBindersFor`, over this test's host. */
  const binders: Record<string, ConnectionBinder> = {
    fortnox: {
      list: (h, row) => listFortnoxBindings(h, row.id),
      bind: (h, row, target) =>
        bindFortnoxScope(h, { ...(target as Parameters<typeof bindFortnoxScope>[1]), connectionId: row.id, externalAccountRef: row.externalAccountRef }),
      options: (raw) => connectionBindingOptions('fortnox').parse(raw ?? {}),
      stale: (binding, row) => ((binding as { externalAccountRef?: string | null }).externalAccountRef ?? null) !== row.externalAccountRef,
    },
    planima: {
      list: (h, row) => listPlanimaBindings(h, row.id),
      bind: (h, row, target) => bindPlanimaScope(h, { ...(target as Parameters<typeof bindPlanimaScope>[1]), connectionId: row.id }),
      options: (raw, current) => {
        const schema = connectionBindingOptions('planima');
        return schema.parse({ ...(current ? schema.strip().parse(current) : {}), ...(raw ?? {}) });
      },
    },
  };
  const pass = () =>
    runPlatformSweep(host, {
      actor: staff,
      fetch,
      sweepers,
      drainRetries: false,
      recordSweepRun: (e) => void runs.push(e),
      connectionLandings: { read: (slug, versionId) => host.versionConnectionLandings(slug, versionId), binders },
    });
  /** The last sweep row each connection got, by id. */
  const lastRun = (id: ConnectionId) => runs.filter((r) => r.connectionId === id).at(-1);
  const audited = async (action: string) => (await host.admin.auditLog(staff, {})).filter((e) => e.action === action).length;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'connection-landings-'));
    fortnox = new FortnoxMock();
    fortnox.setSie(
      2,
      ['#FLAGGA 0', '#FORMAT PC8', '#SIETYP 4', '#FNAMN "Acme AB"', '#ORGNR 556677-8899', '#VALUTA SEK', '#RAR 0 20260101 20261231',
        '#KONTO 3010 "Hyresintäkter"', '#KONTO 1510 "Kundfordringar"', '#VER A 1 20260515 "Hyra"', '{', '#TRANS 3010 {} -500.00', '#TRANS 1510 {} 500.00', '}'].join('\n'),
    );
    planima = new PlanimaMock({
      organizations: [{ id: 1, name: 'Bostads AB Exempel' }],
      facilities: [{ id: 10, name: 'Kvarteret Önskan', organizationId: 1, address: null, zip_code: null, region: null, tags: [], residential_area: null, non_residential_area: null, year_of_construction: null, description: null }],
      buildings: [],
      components: [],
      actions: [],
    });
    staff = platformActorId.parse(ulid());
    t = tenantId.parse(ulid());
    s = scopeId.parse(ulid());
    ledgerPages = [];
    planPages = [];
    runs = [];
    host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('k', new Uint8Array(32).fill(7)), fetch });
    host.registerModule(crm);
    await host.admin.createTenant(staff, { id: t, slug: 'acme', name: 'Acme' });
    await host.admin.grantEntitlement(staff, t, 'crm');
    await host.admin.registerVertical(staff, { slug: SLUG, name: 'Acme CRM', source: 'builtin' });
    await host.provisionScope(staff, { tenantId: t, scopeId: s, jurisdiction: 'eu', vertical: SLUG });
    await host.admin.activateScope(staff, t, s);
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('grants, binds and lands every connection of a declared provider in one pass', async () => {
    await host.admin.bindScopeVersion(staff, t, s, await publish(manifestDeclaring(DECLARED)));
    // Two Fortnox companies (one connection each, #1267) and one Planima account.
    const companyA = await connect('fortnox', '111111');
    const companyB = await connect('fortnox', '222222');
    const plan = await connect('planima');
    expect(await host.connectionGrantsInScope(t, s)).toEqual([]);

    const report = await pass();

    expect(report.connectionLandings).toEqual({ granted: 3, bound: 3, failed: 0 });
    const held = await host.connectionGrantsInScope(t, s);
    expect(held.map((g) => `${g.connectionId} ${g.permission}`).sort()).toEqual(
      [`${companyA} ledger:record`, `${companyB} ledger:record`, `${plan} plan:record`].sort(),
    );
    expect((await listFortnoxBindings(host, companyA))[0]).toMatchObject({ scopeId: s, operation: 'ledger/record-period', permission: 'ledger:record' });
    expect((await listPlanimaBindings(host, plan))[0]).toMatchObject({
      scopeId: s,
      operation: 'maintenance/record-plan',
      permission: 'plan:record',
      organizationId: null,
      horizonYears: 50,
    });
    // Landed through the declared operations, as each connection.
    expect(ledgerPages.map((p) => p.connectionId).sort()).toEqual([companyA, companyB].sort());
    expect(planPages.length).toBeGreaterThan(0);
    expect(planPages.every((p) => p.connectionId === plan)).toBe(true);
    for (const id of [companyA, companyB, plan]) expect(lastRun(id)).toMatchObject({ outcome: 'ok' });
    expect(await audited('grantToConnection')).toBe(3);
    expect(await audited('bindConnectionScope')).toBe(3);
  });

  it('writes nothing on a pass that finds everything in place, and keeps the sync cursor', async () => {
    await host.admin.bindScopeVersion(staff, t, s, await publish(manifestDeclaring(DECLARED)));
    const plan = await connect('planima');
    await pass();
    const cursor = (await listPlanimaBindings(host, plan))[0]!.lastSync;
    expect(cursor).toBeDefined();

    const again = await pass();

    expect(again.connectionLandings).toEqual({ granted: 0, bound: 0, failed: 0 });
    expect(await audited('grantToConnection')).toBe(1);
    expect(await audited('bindConnectionScope')).toBe(1);
    expect(await listPlanimaBindings(host, plan)).toHaveLength(1);
    // A re-bind would have reset it, and the next sync would re-land the whole plan.
    expect((await listPlanimaBindings(host, plan))[0]!.lastSync).toEqual(cursor);
  });

  it('re-binds when the declaration changes, and leaves an option it does not name alone', async () => {
    const plan = await connect('planima');
    await host.admin.bindScopeVersion(staff, t, s, await publish(manifestDeclaring(DECLARED)));
    await pass();
    await bindPlanimaScope(host, {
      connectionId: plan, tenantId: t, scopeId: s, vertical: SLUG,
      operation: 'maintenance/record-plan', permission: 'plan:record',
      organizationId: 42, currency: 'EUR', window: { fromYear: 2026, toYear: 2030 }, horizonYears: 50,
    });
    const narrowed = DECLARED.map((l) => (l.provider === 'planima' ? { ...l, options: { horizonYears: 10 } } : l));
    await host.admin.bindScopeVersion(staff, t, s, await publish(manifestDeclaring(narrowed)));

    const report = await pass();

    expect(report.connectionLandings).toEqual({ granted: 0, bound: 1, failed: 0 });
    expect((await listPlanimaBindings(host, plan))[0]).toMatchObject({
      horizonYears: 10, organizationId: 42, currency: 'EUR', window: { fromYear: 2026, toYear: 2030 },
    });
    expect((await pass()).connectionLandings).toEqual({ granted: 0, bound: 0, failed: 0 });
  });

  it('re-writes a Fortnox binding that predates the company it reads, once', async () => {
    await host.admin.bindScopeVersion(staff, t, s, await publish(manifestDeclaring(DECLARED)));
    const company = await connect('fortnox', '111111');
    // A binding a person wrote before bindings recorded the company: it matches the declaration.
    await host.admin.grantToConnection(staff, { connectionId: company, permission: LEDGER_RECORD, node: { tenantId: t, scopeId: s }, grantedBy: staff });
    await bindFortnoxScope(host, { connectionId: company, tenantId: t, scopeId: s, vertical: SLUG, operation: 'ledger/record-period', permission: LEDGER_RECORD });

    expect((await pass()).connectionLandings).toEqual({ granted: 0, bound: 1, failed: 0 });
    expect((await listFortnoxBindings(host, company))[0]).toMatchObject({ externalAccountRef: '111111' });
    expect((await pass()).connectionLandings).toEqual({ granted: 0, bound: 0, failed: 0 });
  });

  it('stops at a revoked connection: no key is seated again and nothing is swept', async () => {
    await host.admin.bindScopeVersion(staff, t, s, await publish(manifestDeclaring(DECLARED)));
    const plan = await connect('planima');
    await pass();
    await host.admin.revokeConnection(staff, plan);
    runs = [];
    planPages = [];

    const report = await pass();

    expect(report.connectionLandings).toEqual({ granted: 0, bound: 0, failed: 0 });
    expect(await audited('grantToConnection')).toBe(1);
    expect(planPages).toEqual([]);
    expect(lastRun(plan)).toBeUndefined();
  });

  it('grants nothing from a version that declares nothing', async () => {
    await host.admin.bindScopeVersion(staff, t, s, await publish(manifestDeclaring(undefined)));
    const plan = await connect('planima');

    const report = await pass();

    expect(report.connectionLandings).toEqual({ granted: 0, bound: 0, failed: 0 });
    expect(await host.connectionGrantsInScope(t, s)).toEqual([]);
    // Nothing bound, so nothing polled — and the row says so instead of `ok`.
    expect(lastRun(plan)).toMatchObject({ outcome: 'skipped', error: NO_BINDING });
  });

  it('reports a declaration the provider refuses on the connection, never binding with a guess', async () => {
    const typo = DECLARED.map((l) => (l.provider === 'planima' ? { ...l, options: { horizonYear: 50 } } : l));
    await host.admin.bindScopeVersion(staff, t, s, await publish(manifestDeclaring(typo)));
    const plan = await connect('planima');

    const report = await pass();

    expect(report.connectionLandings).toMatchObject({ bound: 0, failed: 1 });
    expect(await listPlanimaBindings(host, plan)).toEqual([]);
    expect(lastRun(plan)).toMatchObject({ outcome: 'failed', error: expect.stringContaining(`scope ${s}`) });
  });
});

/**
 * #2316 ask 3: a resolved sweep is not a landed one. Before, the pass recorded `ok` whenever the
 * sweeper returned, so "not bound", "bound but every page refused" and "landed" read the same.
 */
describe('connector sweep outcome (#2316)', () => {
  const PLAN_RECORD = permissionKey.parse('plan:record');
  let dir: string;
  let host: SqliteScopeHost;
  let planima: PlanimaMock;
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  let runs: SweepRunInput[];

  const refusing: ModuleRegistration = {
    manifest: moduleManifest.parse({
      id: '@acme/plan',
      version: '1.0.0',
      kernelContract: '^0.0.1',
      permissions: [{ key: 'plan:record', description: 'land a maintenance plan' }],
      events: { emits: [], consumes: [] },
      migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
      attachmentTargets: [],
      entitlementKey: 'plan',
    }),
    ...undeclaredOperations('a test fixture whose landing operation always refuses', {
      'maintenance/record-plan': (async (ctx) => {
        assertAllowed(await ctx.check(PLAN_RECORD));
        throw new Error('plan closed for the year');
      }) as OperationHandler<never, unknown>,
    }),
  };

  const sweep = () =>
    runPlatformSweep(host, {
      actor: staff,
      fetch: planima.fetch,
      sweepers: {
        planima: (h, id, o) => sweepPlanimaPlan(h, id, { ...o, apiBase: planima.apiBase, sleep: async () => {} }),
        // A dispatch connector whose answer has the same two names and means something else.
        scrive: async () => ({ found: 0, failed: [] }),
      },
      drainRetries: false,
      recordSweepRun: (e) => void runs.push(e),
      // Planima binds; its answer is read. The version declares nothing, so nothing is granted here.
      connectionLandings: {
        read: async () => ({ kind: 'none' }),
        binders: { planima: { list: (h, row) => listPlanimaBindings(h, row.id), bind: async () => undefined } },
      },
    });
  const connect = async (): Promise<ConnectionId> => {
    const id = connectionId.parse(ulid());
    await host.admin.createConnection(staff, { id, tenantId: t, vertical: 'maintenance', provider: 'planima', label: 'Planima', scopes: [], secret: { token: 'planima-test-token' } });
    return id;
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sweep-outcome-'));
    planima = new PlanimaMock({
      organizations: [{ id: 1, name: 'Bostads AB Exempel' }],
      facilities: [{ id: 10, name: 'Kvarteret Önskan', organizationId: 1, address: null, zip_code: null, region: null, tags: [], residential_area: null, non_residential_area: null, year_of_construction: null, description: null }],
      buildings: [],
      components: [],
      actions: [],
    });
    runs = [];
    host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('k', new Uint8Array(32).fill(7)), fetch: planima.fetch });
    host.registerModule(refusing);
    await host.admin.createTenant(staff, { id: t, slug: 'acme', name: 'Acme' });
    await host.admin.grantEntitlement(staff, t, 'plan');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, jurisdiction: 'eu', vertical: 'maintenance' });
    await host.admin.activateScope(staff, t, s);
  });
  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('records a dispatch connector by whether it resolved, not by its answer\'s field names', async () => {
    const id = connectionId.parse(ulid());
    await host.admin.createConnection(staff, { id, tenantId: t, vertical: 'maintenance', provider: 'scrive', label: 'Scrive', scopes: [], secret: { token: 'x' } });
    await sweep();
    expect(runs.filter((r) => r.connectionId === id)).toEqual([expect.objectContaining({ outcome: 'ok' })]);
  });

  it('records a connection with no binding as skipped, not ok', async () => {
    const id = await connect();
    const report = await sweep();
    expect(runs.filter((r) => r.connectionId === id)).toEqual([expect.objectContaining({ outcome: 'skipped', error: NO_BINDING })]);
    expect(report.errors).toEqual([]);
  });

  it('records a binding whose every page is refused as failed, naming the scope', async () => {
    const id = await connect();
    await host.admin.grantToConnection(staff, { connectionId: id, permission: PLAN_RECORD, node: { tenantId: t, scopeId: s }, grantedBy: staff });
    await bindPlanimaScope(host, { connectionId: id, tenantId: t, scopeId: s, vertical: 'maintenance', operation: 'maintenance/record-plan', permission: PLAN_RECORD });

    const report = await sweep();

    const row = runs.find((r) => r.connectionId === id);
    expect(row).toMatchObject({ outcome: 'failed', error: expect.stringMatching(new RegExp(`scope ${s}: .*plan closed for the year`)) });
    expect(report.errors).toEqual([expect.objectContaining({ kind: 'sweep', id, error: expect.stringContaining(`scope ${s}`) })]);
  });
});
