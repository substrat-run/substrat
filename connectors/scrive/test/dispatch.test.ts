import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  connectionId,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type PermissionKey,
} from '@substrat-run/contracts';
import {
  ulid,
  webCryptoSecretBox,
  type ConnectorOptions,
  type ScopeStub,
} from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { PROTOCOL_PERM as PERM, protocolModule } from '@substrat-run/engine-protocol';
import {
  ScriveMock,
  registerScriveConnector,
  scriveCallbackPath,
  type ScriveConnectorOptions,
  type ScriveDispatchState,
  type ScriveMockOptions,
} from '../src/index.js';

/**
 * The outbound half, end to end: a vertical freezes a document and asks for
 * signatures, and a Scrive document appears at the provider with the right
 * parties and a file attached.
 *
 * Everything here runs against `ScriveMock`, so what is proven is that OUR
 * shape works — credential resolution, egress, the document lifecycle, retry.
 * It is not evidence that our reading of Scrive's API is correct; the mock is
 * the same reading. That check needs a testbed account.
 */
describe('scrive connector — outbound dispatch', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let scrive: ScriveMock;
  let connId: ReturnType<typeof connectionId.parse>;
  let staff = platformActorId.parse(ulid());
  let t = tenantId.parse(ulid());
  let s = scopeId.parse(ulid());
  let stub: ScopeStub;

  const EMPLOYEE = { entityType: 'employee', entityId: '01JEMPLOYEE0000000000000AA' };

  /**
   * Stand the whole world up: host, protocol engine, a stand-in vertical, the
   * connector, a tenant/scope/connection and a template. Parameterised by the
   * connector's own options so a test can prove a CONNECTION-level policy (#620's
   * `defaultAuthMethod`) rather than only the shipped default.
   */
  const boot = async (
    connectorOptions: Partial<ScriveConnectorOptions & { retry: ConnectorOptions }> = {},
    mockOptions: ScriveMockOptions = {},
  ) => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-scrive-'));
    scrive = new ScriveMock(mockOptions);

    staff = platformActorId.parse(ulid());
    t = tenantId.parse(ulid());
    s = scopeId.parse(ulid());

    host = new SqliteScopeHost({
      dir,
      secretBox: webCryptoSecretBox('k', new Uint8Array(32).fill(5)),
      fetch: scrive.fetch,
    });
    host.registerModule(protocolModule);
    // Stands in for the vertical: declares the entity edge and nothing else.
    host.registerModule({
      manifest: {
        id: '@test/hr',
        version: '1.0.0',
        kernelContract: '^0.0.1',
        permissions: [],
        events: { emits: [], consumes: [] },
        migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
        attachmentTargets: [],
        entityRelations: [{ entityType: 'protocol', parentType: 'employee' }],
        entitlementKey: 'hr',
      } as never,
    });

    registerScriveConnector(host, {
      baseUrl: 'https://api-testbed.scrive.test',
      callbackUrl: (ref) => `https://vertical.test${scriveCallbackPath(ref)}`,
      // Retry immediately, so a test can watch a failure recover rather than
      // asserting that a timer it cannot advance would eventually fire.
      retry: { baseDelayMs: 0 },
      ...connectorOptions,
    });

    const principal = principalId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: 'nordljus', name: 'Nordljus' });
    for (const key of ['protocol', 'hr']) await host.admin.grantEntitlement(staff, t, key);
    await host.provisionScope(staff, {
      tenantId: t,
      scopeId: s,
      jurisdiction: 'eu',
      vertical: 'meridian',
    });
    await host.admin.activateScope(staff, t, s);
    await host.admin.defineRole(staff, t, {
      key: 'hr',
      permissions: [
        PERM.create,
        PERM.bind,
        PERM.requestSignature,
        PERM.read,
      ] as PermissionKey[],
      source: 'vertical',
    });
    await host.admin.assignRole(staff, {
      principalId: principal,
      roleKey: 'hr',
      node: { tenantId: t, scopeId: s },
    });
    connId = connectionId.parse(ulid());
    await host.admin.createConnection(staff, {
      id: connId,
      tenantId: t,
      vertical: 'meridian',
      provider: 'scrive',
      label: 'Nordljus Scrive (testbed)',
      secret: { clientId: 'ci', clientSecret: 'cs', tokenId: 'ti', tokenSecret: 'ts' },
    });

    stub = await host.getScope(principal, t, s);
    await stub.invoke('protocol/define-template', {
      key: 'anstallningsavtal',
      title: 'Anställningsavtal',
      content: {
        kind: 'document',
        documentType: 'anstallningsavtal',
        hashRecipe: 'sha256 over the terms row, fields in fixed order',
      },
    });
  };

  beforeEach(() => boot());

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** The connector's dispatch ledger row for an instance, if any. */
  const dispatchState = (instanceId: string) =>
    host.admin.getConnectorState(connId, `scrive:dispatch:${instanceId}`) as Promise<
      ScriveDispatchState | undefined
    >;

  /** Instantiate → bind → request signatures for two parties of different kinds. */
  const issue = async () => {
    const inst = await stub.invoke<{ id: string }>('protocol/instantiate', {
      templateKey: 'anstallningsavtal',
      entityType: EMPLOYEE.entityType,
      entityId: EMPLOYEE.entityId,
    });
    await stub.invoke('protocol/bind-document', {
      instanceId: inst.id,
      contentRef: { entityType: 'employment-terms', entityId: '01JTERMS000000000000000000' },
      contentHash: 'ab'.repeat(32),
    });
    return stub.invoke<{ instance: { id: string }; requests: { id: string }[] }>(
      'protocol/request-signatures',
      {
        instanceId: inst.id,
        method: 'scrive',
        parties: [
          { label: 'Arbetsgivare', kind: 'principal', signatureKind: 'primary' },
          { label: 'Anställd', kind: 'external' },
        ],
      },
    );
  };

  it('turns a signature request into a started Scrive document', async () => {
    const sent = await issue();

    expect(scrive.documents.size).toBe(1);
    const [doc] = [...scrive.documents.values()];
    // Started means Scrive has invited the parties — the file and parties were
    // both accepted, which is what `start` refuses without.
    expect(doc!.status).toBe('pending');
    // A file was uploaded (Scrive does not echo the filename, so assert bytes).
    expect(doc!.file!.bytes).toBeGreaterThan(0);
    expect(doc!.title).toContain('anstallningsavtal');

    // #620: BOTH parties authenticate with `standard`, because neither request
    // asked for more. This assertion used to read `se_bankid` for the external
    // party — the hardcoded requirement that made Scrive refuse every document
    // this connector ever sent (`409 … requires valid personal number field`),
    // since the platform supplies no personnummer by design.
    expect(doc!.parties.map((p) => [p.name, p.auth])).toEqual([
      ['Arbetsgivare', 'standard'],
      ['Anställd', 'standard'],
    ]);

    // A capability URL, because Scrive's callbacks carry no signature to verify:
    // (connection, instance) route it, and the minted token authenticates it.
    expect(doc!.callbackUrl).toContain(sent.instance.id);
    expect(doc!.callbackUrl).toMatch(/\/hooks\/scrive\/[0-9A-HJKMNP-TV-Z]{26}\/[^/]+\/[0-9a-f]{64}$/);

    // The dispatch is recorded in the connector's directory ledger — the id, so
    // a redelivery can find it and skip, and the request ids the poll driver
    // will later need to record signatures against.
    const state = await dispatchState(sent.instance.id);
    expect(state!.documentId).toBe(doc!.id);
    expect(state!.parties.map((p) => p.requestId)).toEqual(sent.requests.map((r) => r.id));
    expect(state!.scopeId).toBe(s);
  });

  // #620. The connector hardcoded `se_bankid` for external parties, which Scrive
  // will not start without a `personal_number` FIELD on the party. The result was a
  // requirement the caller could neither see nor satisfy, and a production tenant
  // whose every contract failed. #687 then measured what that field actually
  // demands — presence, not a value — so `strong` no longer has to be refused.
  describe('the authentication method comes from the caller (#620)', () => {
    /** Issue a set whose single external party asks for `level`. */
    const issueAt = async (level?: 'basic' | 'strong') => {
      const inst = await stub.invoke<{ id: string }>('protocol/instantiate', {
        templateKey: 'anstallningsavtal',
        entityType: EMPLOYEE.entityType,
        entityId: EMPLOYEE.entityId,
      });
      await stub.invoke('protocol/bind-document', {
        instanceId: inst.id,
        contentRef: { entityType: 'employment-terms', entityId: '01JTERMS000000000000000AUT' },
        contentHash: '11'.repeat(32),
      });
      return stub.invoke('protocol/request-signatures', {
        instanceId: inst.id,
        method: 'scrive',
        parties: [{ label: 'Anställd', kind: 'external', ...(level ? { authLevel: level } : {}) }],
      });
    };

    it("defaults to 'standard', so a document actually starts", async () => {
      await issueAt();
      const [doc] = [...scrive.documents.values()];
      expect(doc!.status).toBe('pending'); // started — the 409 is gone
      expect(doc!.parties.map((p) => p.auth)).toEqual(['standard']);
    });

    it("honours a connection-level default for parties that ask for 'basic'", async () => {
      // A deployment that supplies personal numbers by other means can still put
      // every `basic` party on BankID — the policy belongs to the connection, not
      // to a hardcoded branch on `kind`. Re-boot the world with that option set.
      const discarded = dir; // `boot` rebinds `dir`; afterEach only cleans the live one
      await host.close();
      await boot({ defaultAuthMethod: 'se_bankid' });
      rmSync(discarded, { recursive: true, force: true });
      await issueAt();
      const [doc] = [...scrive.documents.values()];
      expect(doc!.status).toBe('pending');
      expect(doc!.parties.map((p) => p.auth)).toEqual(['se_bankid']);
    });

    it("dispatches 'strong' as BankID, carrying the EMPTY personal_number field (#687)", async () => {
      // This used to be "refuses 'strong' before any egress". The refusal was
      // reasoned from a true observation — Scrive 409s a BankID party with no
      // `personal_number` — and a false inference: that satisfying it needs a
      // personnummer, which this platform may not carry. Probed against the
      // testbed, an EMPTY field draws exactly the same errors as a filled one, so
      // the field costs no PII and the signatory completes it during the ceremony.
      await issueAt('strong');

      const [doc] = [...scrive.documents.values()];
      expect(doc!.status).toBe('pending'); // it starts — no refusal, no 409
      expect(doc!.parties.map((p) => p.auth)).toEqual(['se_bankid']);
      // The mock enforces the rule the testbed enforces: presence, not value.
      // Without `update` sending the empty field this assertion — and `start` —
      // would both fail.
      expect(doc!.parties.every((p) => p.hasPersonalNumber)).toBe(true);
    });

    it('still cannot deliver: no party carries an address (#687 item 1)', async () => {
      // The gap that outlives this fix, stated where it will fail loudly when it
      // closes. `strictDelivery` makes the mock apply the testbed's OTHER `start`
      // rule — a party with no `email` field cannot be invited — which no party
      // this connector builds can satisfy, at either auth level. So the flow is
      // blocked on a contact carrier, never on the auth level, and the refusal
      // removed above was never what stood between a request and a signature.
      //
      // One attempt, so the failure lands in the dead-letter record immediately
      // rather than after eight backoffs a test cannot advance through.
      const discarded = dir;
      await host.close();
      await boot({ retry: { maxAttempts: 1, baseDelayMs: 0 } }, { strictDelivery: true });
      rmSync(discarded, { recursive: true, force: true });

      // The operation SUCCEEDS — the freeze is committed and the request rows
      // exist. Only the delivery fails, and this time the reason is the provider's.
      await issueAt('basic');

      const [dead] = await host.executorDeadLetters(t, s);
      expect(dead!.eventType).toBe('protocol.signatures-requested');
      expect(dead!.error).toMatch(/409/);
      expect(dead!.error).toMatch(/requires valid email field/);
    });
  });

  it('skips a dispatch already recorded — the idempotency guard', async () => {
    // At-least-once delivery means the handler can run twice for one event; the
    // second run must NOT create a second contract. The guard is a directory
    // ledger read, so seeding it is exactly "this was already dispatched".
    const inst = await stub.invoke<{ id: string }>('protocol/instantiate', {
      templateKey: 'anstallningsavtal',
      entityType: EMPLOYEE.entityType,
      entityId: EMPLOYEE.entityId,
    });
    await stub.invoke('protocol/bind-document', {
      instanceId: inst.id,
      contentRef: { entityType: 'employment-terms', entityId: '01JTERMS000000000000000009' },
      contentHash: 'ef'.repeat(32),
    });
    await host.admin.putConnectorState(connId, `scrive:dispatch:${inst.id}`, {
      documentId: 'already-sent',
      instanceId: inst.id,
      scopeId: s,
      tenantId: t,
      vertical: 'meridian',
      contentHash: 'ef'.repeat(32),
      parties: [],
      dispatchedAt: '2026-01-01T00:00:00.000Z',
    });

    await stub.invoke('protocol/request-signatures', {
      instanceId: inst.id,
      method: 'scrive',
      parties: [
        { label: 'Arbetsgivare', kind: 'principal', signatureKind: 'primary' },
        { label: 'Anställd', kind: 'external' },
      ],
    });

    // The connector found the ledger row and did nothing — no second document.
    expect(scrive.documents.size).toBe(0);
    // And the ledger is untouched (it did not overwrite with a new dispatch).
    const state = await dispatchState(inst.id);
    expect(state!.documentId).toBe('already-sent');
  });

  it('does not answer for a provider that is not Scrive', async () => {
    // The same event carries `method`. A vertical asking for BankID through
    // someone else must not get a Scrive document.
    const inst = await stub.invoke<{ id: string }>('protocol/instantiate', {
      templateKey: 'anstallningsavtal',
      entityType: 'employee',
      entityId: '01JEMPLOYEE0000000000000BB',
    });
    await stub.invoke('protocol/bind-document', {
      instanceId: inst.id,
      contentRef: { entityType: 'employment-terms', entityId: '01JTERMS000000000000000001' },
      contentHash: 'cd'.repeat(32),
    });
    await stub.invoke('protocol/request-signatures', {
      instanceId: inst.id,
      method: 'assently',
      parties: [{ label: 'Anställd', kind: 'external' }],
    });
    expect(scrive.documents.size).toBe(0);
  });

  it('records provider failure on the connection and retries rather than losing the request', async () => {
    scrive.failWith = 503;
    await issue();

    // The operation succeeded — the freeze is committed and the request rows
    // exist. Only the delivery failed, and that is not the caller's problem.
    const [listed] = await stub.invoke<{ instance: { id: string } }[]>('protocol/list-for-entity', {
      entityType: EMPLOYEE.entityType,
      entityId: EMPLOYEE.entityId,
    });
    const instanceId = listed!.instance.id;
    const detail = await stub.invoke<{ instance: { status: string } }>('protocol/get', {
      instanceId,
    });
    expect(detail.instance.status).toBe('pending_signature');
    expect(await dispatchState(instanceId)).toBeUndefined(); // nothing recorded

    // Health landed on the connection…
    const [conn] = await host.admin.listConnections(staff, { tenantId: t });
    expect(conn!.status).toBe('error');
    expect(conn!.lastError).toContain('503');

    // …and the delivery is retrying, not dead: 8 attempts is deliberate, since
    // giving up after five would mean giving up on a contract.
    expect(await host.executorDeadLetters(t, s)).toEqual([]);

    // The provider recovers. The next drain completes the dispatch — the point
    // of retrying at all, and the thing a green "it failed" test never shows.
    scrive.failWith = undefined;
    const report = await host.drainDue(t, s);
    expect(report.delivered).toBe(1);
    expect(scrive.documents.size).toBe(1);

    // Health recovered with it.
    const [healed] = await host.admin.listConnections(staff, { tenantId: t });
    expect(healed!.status).toBe('active');
    expect(healed!.lastError).toBeNull();
  });

  it('refuses to dispatch when the tenant has no Scrive connection', async () => {
    const [conn] = await host.admin.listConnections(staff, { tenantId: t });
    await host.admin.revokeConnection(staff, conn!.id);
    await issue();

    // Nothing was sent, and nothing was recorded as sent — the two together are
    // what distinguish a refused dispatch from a silent no-op.
    expect(scrive.documents.size).toBe(0);
    const [summ0] = await stub.invoke<{ instance: { id: string } }[]>('protocol/list-for-entity', {
      entityType: EMPLOYEE.entityType,
      entityId: EMPLOYEE.entityId,
    });
    expect(await dispatchState(summ0!.instance.id)).toBeUndefined();
    void summ0;

    // The freeze still committed: the operation is not the delivery.
    const [summary] = await stub.invoke<{ instance: { status: string } }[]>(
      'protocol/list-for-entity',
      { entityType: EMPLOYEE.entityType, entityId: EMPLOYEE.entityId },
    );
    expect(summary!.instance.status).toBe('pending_signature');

    // And it keeps retrying rather than dying, because a revoked connection is
    // usually an operator about to connect a new one.
    const report = await host.drainDue(t, s);
    expect(report.retrying + report.deadLettered).toBe(1);
    expect(report.delivered).toBe(0);
  });
});
