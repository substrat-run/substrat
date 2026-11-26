import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import {
  assertAllowed,
  runPlatformSweep,
  ulid,
  undeclaredOperations,
  webCryptoSecretBox,
  type ConnectionBinder,
  type FetchLike,
  type ModuleRegistration,
  type OperationHandler,
} from '@substrat-run/kernel';
import { moduleManifest, permissionKey, platformActorId, principalId, scopeId, tenantId, type ScopeId } from '@substrat-run/contracts';
import {
  FortnoxMock,
  bindFortnoxScope,
  listFortnoxBindings,
  sweepFortnoxLedger,
  unbindFortnoxScope,
  type FortnoxLedgerPage,
} from '@substrat-run/connector-fortnox';
import {
  ConnectUrlRelayError,
  ConnectionRelayError,
  NOT_A_SCOPE_ROUND,
  connectionBindingOptions,
  relayConnectUrl,
  relayConsentedConnection,
  signConnectState,
  type ConnectionBindingRelayOptions,
} from '../src/index.js';
import { heldVersion } from './held-manifest.js';

/**
 * #3410, end to end: a tenant runs several stores, each its own scope of one vertical, and each
 * keeps its own books in its own Fortnox company. Each store starts a consent round from its own
 * screen asked for as its OWN connection (`connect-url` with `owner: 'scope'`), and the round's
 * callback ends at the control plane, which verifies the signed state, stores the company as that
 * store's own and binds it there alone. The vertical never learns the connection's id.
 *
 * The connector is wired as the control plane's registration wires it (`scopeOwned`, the binder
 * handing the row's company and owner to `bindFortnoxScope`).
 */
describe("a store's own Fortnox company lands in that store alone (#3410)", () => {
  const SLUG = 'acme-stores';
  const RECORD = permissionKey.parse('ledger:record');
  const OPERATION = 'stores/record-ledger';
  const SECRET = 'platform-secret-for-tests';
  const actor = platformActorId.parse(ulid());
  const person = principalId.parse(ulid());
  const COMPANY_A = '111111';
  const COMPANY_B = '222222';

  let dir: string;
  let host: SqliteScopeHost;
  /** Each store's own company, at Fortnox. */
  let books: Record<string, FortnoxMock>;
  let fetch: FetchLike;
  let t: ReturnType<typeof tenantId.parse>;
  let a: ScopeId;
  let b: ScopeId;
  /** What each store's landing operation was handed, by the scope it ran in. */
  let landed: { scopeId: string; page: FortnoxLedgerPage }[];

  const binder: ConnectionBinder = {
    list: (h, row) => listFortnoxBindings(h, row.id),
    bind: (h, row, target) =>
      bindFortnoxScope(h, {
        ...(target as Parameters<typeof bindFortnoxScope>[1]),
        connectionId: row.id,
        externalAccountRef: row.externalAccountRef,
        ownerScopeId: row.ownerScopeId,
      }),
    bindBeforeGrant: (h, row, target) =>
      bindFortnoxScope(h, {
        ...(target as Parameters<typeof bindFortnoxScope>[1]),
        connectionId: row.id,
        externalAccountRef: row.externalAccountRef,
        ownerScopeId: row.ownerScopeId,
        grantPreflighted: true,
      }),
    options: (raw) => connectionBindingOptions('fortnox').parse(raw ?? {}),
    unbind: (h, row, s) => unbindFortnoxScope(h, row.id, s),
  };
  const landings = (): ConnectionBindingRelayOptions['landings'] => ({
    read: (slug, versionId) => host.versionConnectionLandings(slug, versionId),
    binders: { fortnox: binder },
  });
  const scopeOwnable = (p: string) => p === 'fortnox';

  /** A store's worker asks for a round as its own; answers the signed state the browser carries. */
  const mint = async (s: ScopeId, proven = true): Promise<string> => {
    const { url } = await relayConnectUrl(
      host,
      actor,
      { tenantId: t, scopeId: s, provider: 'fortnox', createdBy: person, owner: 'scope' },
      {
        connectOrigin: 'https://app.example.com',
        platformSecret: SECRET,
        flows: { fortnox: { startPath: '/api/integrations/fortnox/connect' } },
        scopeOwned: { proven, scopeOwnable, readLandings: (slug, v) => host.versionConnectionLandings(slug, v) },
      },
    );
    return new URL(url).searchParams.get('token')!;
  };

  /** The callback, once the company consented: the credential and the state, relayed. */
  const consented = (state: string, company: string) =>
    relayConsentedConnection(
      host,
      actor,
      t,
      { state, label: `Fortnox — ${company}`, externalAccountRef: company, secret: { clientId: 'client-id', clientSecret: 'client-secret', tenantId: company } },
      { platformSecret: SECRET, landings: landings(), scopeOwnable },
    );

  const pass = () =>
    runPlatformSweep(host, {
      actor,
      fetch,
      sweepers: {
        fortnox: (h, id, o) =>
          sweepFortnoxLedger(h, id, { ...o, apiBase: books[COMPANY_A]!.apiBase, oauthBase: books[COMPANY_A]!.oauthBase, period: { from: '2026-01-01', to: '2026-12-31' } }),
      },
      drainRetries: false,
      recordFailure: () => {},
      connectionLandings: landings(),
    });

  const into = (s: ScopeId) => [...new Set(landed.filter((l) => l.scopeId === s).map((l) => `${l.page.connectionId} ${l.page.company.name}`))];
  const sie = (name: string, amount: string) =>
    ['#FLAGGA 0', '#FORMAT PC8', '#SIETYP 4', `#FNAMN "${name}"`, '#RAR 0 20260101 20261231', '#KONTO 3010 "Intäkter"', '#VER A 1 20260615 "Sale"', '{', `#TRANS 3010 {} ${amount}`, '}'].join('\r\n');

  /** Publish a version of the vertical, binding it to `scopes`; on request unless `everyInstall`. */
  const publish = async (scopes: ScopeId[], everyInstall = false) => {
    const id = ulid();
    await host.admin.publishVersion(actor, await heldVersion({
      id, verticalSlug: SLUG, version: `1.0.${id.toLowerCase()}`, manifestDigest: `m-${id}`, permissionDigest: 'p', migrationDigest: 'g', deploymentRef: null,
      manifestJson: JSON.stringify({
        registry: {
          permissions: [{ key: RECORD, description: 'land a store ledger', declaredBy: ['@acme/stores'] }],
          roles: [],
          entityGrants: [],
          connections: [{ provider: 'fortnox', operation: OPERATION, permission: RECORD, ...(everyInstall ? {} : { bind: 'on-request' }), declaredBy: ['@acme/stores'] }],
        },
      }),
    }));
    await host.admin.admitVersion(actor, id);
    for (const s of scopes) await host.admin.bindScopeVersion(actor, t, s, id);
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fortnox-scope-own-'));
    landed = [];
    books = {};
    for (const [company, name] of [[COMPANY_A, 'Store A AB'], [COMPANY_B, 'Store B AB']] as const) {
      books[company] = new FortnoxMock({ tenantId: company, company: { CompanyName: name, OrganizationNumber: `556000-${company.slice(0, 4)}`, DatabaseNumber: Number(company) } });
      books[company]!.setSie(2, sie(name, '-100.00'));
    }
    // Both companies answer at Fortnox's one origin: the token mint is routed by the company it
    // names, and every later call by the company the token was minted for.
    fetch = (async (input: string, init?: { headers?: Record<string, string> }) => {
      const headers = { ...(init?.headers ?? {}) };
      if (String(input).endsWith('/oauth-v1/token')) {
        const company = headers['TenantId'] ?? '';
        const res = await books[company]!.fetch(input, init as never);
        const body = JSON.parse(await res.text()) as { access_token?: string };
        if (body.access_token) body.access_token = `${company}:${body.access_token}`;
        return new Response(JSON.stringify(body), { status: res.status, headers: { 'content-type': 'application/json' } });
      }
      const [company, token] = (headers['Authorization'] ?? '').replace(/^Bearer /, '').split(':');
      return books[company ?? '']!.fetch(input, { ...init, headers: { ...headers, Authorization: `Bearer ${token}` } } as never);
    }) as unknown as FetchLike;
    host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('k', new Uint8Array(32).fill(7)), fetch });
    const module: ModuleRegistration = {
      manifest: moduleManifest.parse({
        id: '@acme/stores',
        version: '1.0.0',
        kernelContract: '^0.0.1',
        permissions: [{ key: RECORD, description: 'land a store ledger' }],
        events: { emits: [], consumes: [] },
        migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
        attachmentTargets: [],
        entitlementKey: SLUG,
      }),
      ...undeclaredOperations("a test fixture standing in for the vertical's landing operation", {
        [OPERATION]: (async (ctx, input: FortnoxLedgerPage) => {
          assertAllowed(await ctx.check(RECORD));
          landed.push({ scopeId: ctx.scopeId, page: input });
          return { ok: true };
        }) as OperationHandler<never, unknown>,
      }),
    };
    host.registerModule(module);
    t = tenantId.parse(ulid());
    a = scopeId.parse(ulid());
    b = scopeId.parse(ulid());
    await host.admin.createTenant(actor, { id: t, slug: 'acme', name: 'Acme' });
    await host.admin.grantEntitlement(actor, t, SLUG);
    await host.admin.registerVertical(actor, { slug: SLUG, name: 'Acme Stores', source: 'builtin' });
    for (const s of [a, b]) {
      await host.provisionScope(actor, { tenantId: t, scopeId: s, jurisdiction: 'eu', vertical: SLUG });
      await host.admin.activateScope(actor, t, s);
    }
    await publish([a, b]);
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("binds each store's round to that store alone, lands only its own company's ledger, and revoking one stops only that store's sync", async () => {
    const roundA = await consented(await mint(a), COMPANY_A);
    const roundB = await consented(await mint(b), COMPANY_B);
    // Bound by the round, with no second call, and to the scope that started it.
    expect(roundA).toMatchObject({ created: true, scopeId: a, bound: { scopeId: a } });
    expect(roundB).toMatchObject({ created: true, scopeId: b, bound: { scopeId: b } });
    const rows = await host.admin.listConnections(actor, { tenantId: t, vertical: SLUG });
    expect(rows.map((r) => [r.id, r.externalAccountRef, r.ownerScopeId, r.createdBy]).sort()).toEqual(
      [[roundA.connectionId, COMPANY_A, a, person], [roundB.connectionId, COMPANY_B, b, person]].sort(),
    );

    await pass();

    expect(into(a)).toEqual([`${roundA.connectionId} Store A AB`]);
    expect(into(b)).toEqual([`${roundB.connectionId} Store B AB`]);
    expect(await host.connectionGrantsInScope(t, a)).toEqual([expect.objectContaining({ connectionId: roundA.connectionId })]);
    expect(await host.connectionGrantsInScope(t, b)).toEqual([expect.objectContaining({ connectionId: roundB.connectionId })]);

    // Store A disconnects its company; the books change; only store B's sync goes on.
    await host.admin.revokeConnection(actor, roundA.connectionId);
    books[COMPANY_A]!.setSie(2, sie('Store A AB', '-250.00'));
    books[COMPANY_B]!.setSie(2, sie('Store B AB', '-250.00'));
    const before = landed.length;
    await pass();
    expect([...new Set(landed.slice(before).map((l) => l.scopeId))]).toEqual([b]);
  });

  it("rotates a store's own connection on a re-consent, and makes the same company another store's own from there", async () => {
    const first = await consented(await mint(a), COMPANY_A);
    const again = await consented(await mint(a), COMPANY_A);
    expect(again).toMatchObject({ connectionId: first.connectionId, created: false, bound: { scopeId: a } });
    // The same company consented from store B is B's own connection, not a rotation of A's.
    const fromB = await consented(await mint(b), COMPANY_A);
    expect(fromB).toMatchObject({ created: true, scopeId: b, bound: { scopeId: b } });
    expect(fromB.connectionId).not.toBe(first.connectionId);
    expect((await listFortnoxBindings(host, first.connectionId)).map((x) => x.scopeId)).toEqual([a]);
    expect((await listFortnoxBindings(host, fromB.connectionId)).map((x) => x.scopeId)).toEqual([b]);
  });

  it('refuses a scope round that was never proven, a tenant round, and a version that does not land Fortnox on request', async () => {
    const status = (p: Promise<unknown>) =>
      p.then(() => 200, (e: unknown) => (e instanceof ConnectUrlRelayError || e instanceof ConnectionRelayError ? e.status : e));
    // No URL is minted for a caller not proven to be the scope.
    expect(await status(mint(a, false))).toBe(403);
    // A tenant round's state (no owner), as every round before this one, is not a scope's own.
    const tenantRound = await signConnectState(SECRET, { tenantId: t, scopeId: a, vertical: SLUG, provider: 'fortnox', principal: person, exp: Date.now() + 60_000 });
    await expect(consented(tenantRound, COMPANY_A)).rejects.toMatchObject({ status: 403, message: NOT_A_SCOPE_ROUND });
    // Nor is one signed under another secret, or minted for another tenant.
    const forged = await signConnectState('another-secret', { tenantId: t, scopeId: a, vertical: SLUG, provider: 'fortnox', principal: person, owner: 'scope', exp: Date.now() + 60_000 });
    await expect(consented(forged, COMPANY_A)).rejects.toMatchObject({ status: 403 });
    const otherTenant = await signConnectState(SECRET, { tenantId: ulid(), scopeId: a, vertical: SLUG, provider: 'fortnox', principal: person, owner: 'scope', exp: Date.now() + 60_000 });
    await expect(consented(otherTenant, COMPANY_A)).rejects.toMatchObject({ status: 403 });
    // A round minted while the version landed Fortnox on request, ending after it lands it on every
    // install: the store judges the version as it stands, so nothing is stored.
    const state = await mint(a);
    expect(await status(mint(b))).toBe(200);
    await publish([a, b], true);
    expect(await status(mint(a))).toBe(409);
    await expect(consented(state, COMPANY_A)).rejects.toMatchObject({ status: 409 });
    expect(await host.admin.listConnections(actor, { tenantId: t, vertical: SLUG })).toEqual([]);
  });
});
