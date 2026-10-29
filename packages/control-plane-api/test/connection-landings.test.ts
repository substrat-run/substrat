import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  type PlatformSweepOptions,
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
      bindBeforeGrant: (h, row, target) =>
        bindFortnoxScope(h, { ...(target as Parameters<typeof bindFortnoxScope>[1]), connectionId: row.id, externalAccountRef: row.externalAccountRef, grantPreflighted: true }),
      options: (raw, current) => {
        const parsed = connectionBindingOptions('fortnox').parse(raw ?? {});
        const oldKind = (current as { kind?: string } | undefined)?.kind ?? 'ledger';
        const newKind = parsed.kind ?? 'ledger';
        if (current && oldKind !== newKind) throw new Error(`one Fortnox landing kind per scope; use a separate scope for the other kind (${oldKind} to ${newKind})`);
        return { kind: parsed.kind };
      },
      stale: (binding, row) => ((binding as { externalAccountRef?: string | null }).externalAccountRef ?? null) !== row.externalAccountRef,
    },
    planima: {
      list: (h, row) => listPlanimaBindings(h, row.id),
      bind: (h, row, target) => bindPlanimaScope(h, { ...(target as Parameters<typeof bindPlanimaScope>[1]), connectionId: row.id }),
      bindBeforeGrant: (h, row, target) => bindPlanimaScope(h, { ...(target as Parameters<typeof bindPlanimaScope>[1]), connectionId: row.id, grantPreflighted: true }),
      options: (raw, current) => {
        const schema = connectionBindingOptions('planima');
        return schema.parse({ ...(current ? schema.strip().parse(current) : {}), ...(raw ?? {}) });
      },
    },
  };
  const pass = (sweepEveryMinutes?: Record<string, number>, recordFailure?: PlatformSweepOptions['recordFailure']) =>
    runPlatformSweep(host, {
      actor: staff,
      fetch,
      sweepers,
      ...(sweepEveryMinutes ? { sweepEveryMinutes } : {}),
      drainRetries: false,
      recordSweepRun: (e) => void runs.push(e),
      ...(recordFailure ? { recordFailure } : {}),
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

    expect(report.errors).toEqual([]);
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

  it('seats an invoice declaration but records unsupported without a failed sweep', async () => {
    await host.admin.bindScopeVersion(staff, t, s, await publish(manifestDeclaring([
      { provider: 'fortnox', operation: 'invoices/record', permission: 'ledger:record',
        options: { kind: 'supplier-invoice' }, declaredBy: ['@acme/crm'] },
    ])));
    const id = await connect('fortnox', '111111');
    const report = await pass();

    expect((await listFortnoxBindings(host, id))[0]).toMatchObject({ kind: 'supplier-invoice', operation: 'invoices/record' });
    expect(report.errors).toEqual([]);
    expect(report.connectionLandings?.failed).toBe(0);
    expect(report.connectionsSkipped).toBe(1);
    expect(report.connectionsSwept).toBe(0);
    expect(lastRun(id)).toMatchObject({ outcome: 'unsupported', error: expect.stringContaining('upgrade') });
    expect(ledgerPages).toEqual([]);
    expect(fortnox.calls).toEqual([]);
  });

  it.each([
    ['unchanged operation', 'invoices/record'],
    ['changed operation', 'ledger/record-period'],
  ])('refuses an omitted kind after an invoice binding with %s', async (_label, operation) => {
    const id = await connect('fortnox');
    const invoice = [{ provider: 'fortnox', operation: 'invoices/record', permission: 'ledger:record', options: { kind: 'supplier-invoice' }, declaredBy: ['@acme/crm'] }];
    await host.admin.bindScopeVersion(staff, t, s, await publish(manifestDeclaring(invoice)));
    await pass();
    const before = await host.connectionGrantsInScope(t, s);
    await host.admin.bindScopeVersion(staff, t, s, await publish(manifestDeclaring([
      { provider: 'fortnox', operation, permission: 'plan:record', declaredBy: ['@acme/crm'] },
    ])));

    const report = await pass();

    expect(report.connectionLandings).toMatchObject({ granted: 0, bound: 0, failed: 1 });
    expect(report.errors).toEqual([expect.objectContaining({ error: expect.stringContaining('one Fortnox landing kind per scope; use a separate scope for the other kind') })]);
    expect(await host.connectionGrantsInScope(t, s)).toEqual(before);
    expect((await listFortnoxBindings(host, id))[0]).toMatchObject({ kind: 'supplier-invoice', operation: 'invoices/record', permission: 'ledger:record' });
  });

  it('leaves a staged binding without a grant after a post-write error, then converges on retry', async () => {
    const id = await connect('fortnox');
    await host.admin.bindScopeVersion(staff, t, s, await publish(manifestDeclaring(DECLARED)));
    const original = binders.fortnox!.bindBeforeGrant!;
    binders.fortnox!.bindBeforeGrant = async (...args) => {
      await original(...args);
      throw new Error('injected failure after binding write');
    };
    try {
      const interrupted = await pass();
      expect(interrupted.connectionLandings).toMatchObject({ granted: 0, failed: 1 });
      expect((await listFortnoxBindings(host, id))[0]).toMatchObject({ scopeId: s, operation: 'ledger/record-period' });
      expect(await host.connectionGrantsInScope(t, s)).toEqual([]);
    } finally {
      binders.fortnox!.bindBeforeGrant = original;
    }
    const retried = await pass();
    expect(retried.connectionLandings).toEqual({ granted: 1, bound: 0, failed: 0 });
    expect(await host.connectionGrantsInScope(t, s)).toEqual([expect.objectContaining({ connectionId: id, permission: 'ledger:record' })]);
    expect((await listFortnoxBindings(host, id))).toHaveLength(1);
  });

  it('writes no grant when the binding write fails', async () => {
    const id = await connect('fortnox');
    await host.admin.bindScopeVersion(staff, t, s, await publish(manifestDeclaring(DECLARED)));
    const original = binders.fortnox!.bindBeforeGrant!;
    binders.fortnox!.bindBeforeGrant = async () => { throw new Error('injected bind failure'); };
    try {
      const report = await pass();
      expect(report.connectionLandings).toMatchObject({ granted: 0, bound: 0, failed: 1 });
      expect(await listFortnoxBindings(host, id)).toEqual([]);
      expect(await host.connectionGrantsInScope(t, s)).toEqual([]);
    } finally {
      binders.fortnox!.bindBeforeGrant = original;
    }
  });

  it('does not record another unsupported sweep inside the cadence window', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'));
      const id = await connect('fortnox');
      const invoice = [{ provider: 'fortnox', operation: 'invoices/record', permission: 'ledger:record', options: { kind: 'supplier-invoice' }, declaredBy: ['@acme/crm'] }];
      await host.admin.bindScopeVersion(staff, t, s, await publish(manifestDeclaring(invoice)));
      await pass({ fortnox: 120 });
      expect(lastRun(id)).toMatchObject({ outcome: 'unsupported' });
      await host.admin.recordSweepRun({ kind: 'connector', unit: id, outcome: 'unsupported', tenantId: t, vertical: SLUG, connectionId: id });
      const first = runs.length;
      vi.advanceTimersByTime(60 * 60_000);

      const skipped = await pass({ fortnox: 120 });

      expect(skipped.connectionsSkipped).toBe(1);
      expect(runs).toHaveLength(first);
      vi.advanceTimersByTime(61 * 60_000);
      await pass({ fortnox: 120 });
      expect(runs).toHaveLength(first + 1);
      expect(lastRun(id)).toMatchObject({ outcome: 'unsupported' });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['ledger succeeds', 'ledger/record-period', 'ok'],
    ['ledger fails', 'ledger/missing', 'failed'],
  ])('keeps the invoice limitation visible when a mixed connection %s', async (_label, operation, outcome) => {
    const id = await connect('fortnox');
    const invoiceScope = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: invoiceScope, jurisdiction: 'eu', vertical: SLUG });
    await host.admin.activateScope(staff, t, invoiceScope);
    const ledger = [{ provider: 'fortnox', operation, permission: 'ledger:record', declaredBy: ['@acme/crm'] }];
    const invoice = [{ provider: 'fortnox', operation: 'invoices/record', permission: 'ledger:record', options: { kind: 'supplier-invoice' }, declaredBy: ['@acme/crm'] }];
    await host.admin.bindScopeVersion(staff, t, s, await publish(manifestDeclaring(ledger)));
    await host.admin.bindScopeVersion(staff, t, invoiceScope, await publish(manifestDeclaring(invoice)));

    await pass();

    expect(lastRun(id)).toMatchObject({ outcome, error: expect.stringContaining('supplier-invoice polling is unavailable') });
    if (outcome === 'failed') expect(lastRun(id)?.error).toContain('\n1 of 2 bindings did not land');
    expect((await listFortnoxBindings(host, id))).toEqual(expect.arrayContaining([
      expect.objectContaining({ scopeId: s, operation }),
      expect.objectContaining({ scopeId: invoiceScope, kind: 'supplier-invoice' }),
    ]));
    expect(ledgerPages).toHaveLength(outcome === 'ok' ? 1 : 0);
    const calls = fortnox.calls.length;
    const rows = runs.length;
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(Date.now() + 1000));
      await host.admin.recordSweepRun({ kind: 'connector', unit: id, outcome: outcome as 'ok' | 'failed', tenantId: t, vertical: SLUG, connectionId: id });
      vi.advanceTimersByTime(60 * 60_000);
      await pass({ fortnox: 120 });
      expect(fortnox.calls).toHaveLength(calls);
      expect(runs).toHaveLength(rows);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lands beside a directory row in the tenant that does not read as a scope, which the pass names once", async () => {
    await host.admin.bindScopeVersion(staff, t, s, await publish(manifestDeclaring(DECLARED)));
    const unreadable = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: unreadable, jurisdiction: 'eu', vertical: SLUG });
    await host.admin.activateScope(staff, t, unreadable);
    (host as unknown as { directory: { exec(q: string): void } }).directory.exec(`UPDATE scopes SET vertical = '' WHERE scope_id = '${unreadable}'`);
    const plan = await connect('planima');

    const report = await pass();

    expect(report.connectionLandings).toEqual({ granted: 1, bound: 1, failed: 0 });
    expect(lastRun(plan)).toMatchObject({ outcome: 'ok' });
    expect(report.errors).toEqual([{ kind: 'scope-row', id: unreadable, error: expect.stringMatching(/\(vertical\)/) }]);
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

  it('repairs a changed landing while the provider poll waits for its interval', async () => {
    const plan = await connect('planima');
    await host.admin.bindScopeVersion(staff, t, s, await publish(manifestDeclaring(DECLARED)));
    await pass();
    await host.admin.recordSweepRun({ kind: 'connector', unit: plan, outcome: 'ok', tenantId: t, vertical: SLUG, connectionId: plan });
    const pages = planPages.length;
    const rows = runs.length;
    const changed = DECLARED.map((l) => l.provider === 'planima' ? { ...l, options: { horizonYears: 10 } } : l);
    await host.admin.bindScopeVersion(staff, t, s, await publish(manifestDeclaring(changed)));

    const report = await pass({ planima: 120 });

    expect(report.connectionLandings).toEqual({ granted: 0, bound: 1, failed: 0 });
    expect(report.connectionsSkipped).toBe(1);
    expect((await listPlanimaBindings(host, plan))[0]).toMatchObject({ horizonYears: 10 });
    expect(planPages).toHaveLength(pages);
    expect(runs).toHaveLength(rows);
  });

  it('records a failed landing while the provider poll waits for its interval', async () => {
    const plan = await connect('planima');
    await host.admin.bindScopeVersion(staff, t, s, await publish(manifestDeclaring(DECLARED)));
    await pass();
    await host.admin.recordSweepRun({ kind: 'connector', unit: plan, outcome: 'ok', tenantId: t, vertical: SLUG, connectionId: plan });
    const pages = planPages.length;
    const rows = runs.length;
    const refused = DECLARED.map((l) => l.provider === 'planima' ? { ...l, options: { horizonYear: 50 } } : l);
    await host.admin.bindScopeVersion(staff, t, s, await publish(manifestDeclaring(refused)));
    const staffText: string[] = [];

    const report = await pass({ planima: 120 }, (entry) => void staffText.push(entry.message));

    expect(report.connectionLandings).toMatchObject({ failed: 1 });
    expect(report.connectionsSwept).toBe(0);
    expect(report.connectionsSkipped).toBe(1);
    expect(planPages).toHaveLength(pages);
    expect(runs).toHaveLength(rows + 1);
    expect(lastRun(plan)).toMatchObject({ outcome: 'failed', error: expect.stringMatching(/^1 declared landing could not be granted or bound \(reference \w{26}\)$/) });
    expect(staffText).toHaveLength(1);
    expect(staffText[0]).toContain(`scope ${s}`);
    expect(report.errors).toEqual([]);
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
    expect(lastRun(plan)).toMatchObject({ outcome: 'failed', error: expect.stringMatching(/^1 declared landing could not be granted or bound \(reference \w{26}\)$/) });
    expect(report.errors).toEqual([expect.objectContaining({ kind: 'sweep', id: plan, error: expect.stringContaining(`scope ${s}`) })]);
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

  let filed: Promise<unknown>[];
  const sweep = async (planimaSweeper?: ConnectorSweeper) => {
    const report = await runPlatformSweep(host, {
      actor: staff,
      fetch: planima.fetch,
      sweepers: {
        planima: planimaSweeper ?? ((h, id, o) => sweepPlanimaPlan(h, id, { ...o, apiBase: planima.apiBase, sleep: async () => {} })),
        // A dispatch connector whose answer has the same two names and means something else.
        scrive: async () => ({ found: 0, failed: [] }),
      },
      drainRetries: false,
      recordSweepRun: (e) => void runs.push(e),
      // The control plane's wiring: staff's row on the real ledger.
      recordFailure: (e) => void filed.push(host.admin.recordOpsFailure({ actor: staff, ...e })),
      // Planima binds; its answer is read. The version declares nothing, so nothing is granted here.
      connectionLandings: {
        read: async () => ({ kind: 'none' }),
        binders: { planima: { list: (h, row) => listPlanimaBindings(h, row.id), bind: async () => undefined } },
      },
    });
    await Promise.all(filed);
    return report;
  };
  /**
   * What the staff digest is handed for this pass (`sendFailureDigest`): the ledger since the pass
   * began, and the pass's own errors. Each line that names `text` counts.
   */
  const digestLinesNaming = async (since: string, report: { errors: { error: string }[] }, text: string) =>
    [...(await host.admin.listOpsFailures(staff, { since })).map((f) => f.message), ...report.errors.map((e) => e.error)].filter((l) => l.includes(text));
  const referenceOf = (row: SweepRunInput | undefined) => /\(reference (\w{26})\)$/.exec(row?.error ?? '')?.[1];
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
    filed = [];
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

  it("records a binding whose every page is refused as failed, with the refusal on staff's row alone", async () => {
    const id = await connect();
    await host.admin.grantToConnection(staff, { connectionId: id, permission: PLAN_RECORD, node: { tenantId: t, scopeId: s }, grantedBy: staff });
    await bindPlanimaScope(host, { connectionId: id, tenantId: t, scopeId: s, vertical: 'maintenance', operation: 'maintenance/record-plan', permission: PLAN_RECORD });
    const since = new Date().toISOString();

    const report = await sweep();

    // The tenant's row counts what did not land, under the platform's reference, in its own words.
    const row = runs.find((r) => r.connectionId === id);
    expect(row).toMatchObject({ outcome: 'failed', error: expect.stringMatching(/^1 of 1 binding did not land \(reference \w{26}\)$/) });
    // The refusal is staff's: one row with no tenant, under that reference, naming the scope.
    expect(await host.admin.listOpsFailures(staff, { reference: referenceOf(row)! })).toEqual([
      expect.objectContaining({ tenantId: null, operation: 'sweep.connector:planima', message: expect.stringMatching(new RegExp(`^connection ${id} of tenant ${t}: scope ${s}: .*plan closed for the year`)) }),
    ]);
    expect(await host.admin.listOpsFailures(staff, { tenantId: t })).toEqual([]);
    // The digest is handed it once: from the ledger, not again from the pass's errors.
    expect(await digestLinesNaming(since, report, 'plan closed for the year')).toHaveLength(1);
  });

  it("records a sweep that throws as failed, with the throw on staff's row alone", async () => {
    const id = await connect();
    const since = new Date().toISOString();

    const report = await sweep(async () => {
      throw new Error('Planima GET /facilities failed: upstream body 7f3a');
    });

    const row = runs.find((r) => r.connectionId === id);
    expect(row).toMatchObject({ outcome: 'failed', error: expect.stringMatching(/^the sweep did not complete \(reference \w{26}\)$/) });
    expect(await host.admin.listOpsFailures(staff, { reference: referenceOf(row)! })).toEqual([
      expect.objectContaining({ tenantId: null, message: `connection ${id} of tenant ${t}: Planima GET /facilities failed: upstream body 7f3a` }),
    ]);
    expect(await digestLinesNaming(since, report, 'upstream body 7f3a')).toHaveLength(1);
  });
});
