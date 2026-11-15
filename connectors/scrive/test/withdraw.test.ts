import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  connectionId,
  dataSubjectId,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type PermissionKey,
} from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox, type ScopeStub } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { PROTOCOL_PERM as PERM, protocolModule, getProtocol } from '@substrat-run/engine-protocol';
import {
  ScriveMock,
  registerScriveConnector,
  reconcileScriveDispatch,
  scriveConnectionActivity,
  sweepScriveReconciliations,
  type ScriveDispatchState,
} from '../src/index.js';

/**
 * Taking a request set out of signing (#3127): `protocol.voided` and
 * `protocol.signatures-cancelled` cancel the Scrive document, settle the dispatch row, and
 * leave a signature Scrive took anyway for a person rather than calling it recorded.
 */
describe('scrive connector — a withdrawn request set is cancelled at Scrive (#3127)', () => {
  const BASE = 'https://api-testbed.scrive.test';
  const EMPLOYEE = { entityType: 'employee', entityId: '01JEMPLOYEE0000000000000AA' };
  let dir: string;
  let host: SqliteScopeHost;
  let scrive: ScriveMock;
  let connId: ReturnType<typeof connectionId.parse>;
  let staff = platformActorId.parse(ulid());
  let t = tenantId.parse(ulid());
  let s = scopeId.parse(ulid());
  let stub: ScopeStub;
  let employerRef = principalId.parse(ulid());
  let employeeRef = dataSubjectId.parse(ulid());

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-scrive-withdraw-'));
    scrive = new ScriveMock();
    staff = platformActorId.parse(ulid());
    t = tenantId.parse(ulid());
    s = scopeId.parse(ulid());
    employerRef = principalId.parse(ulid());
    employeeRef = dataSubjectId.parse(ulid());

    host = new SqliteScopeHost({
      dir,
      secretBox: webCryptoSecretBox('k', new Uint8Array(32).fill(5)),
      fetch: scrive.fetch,
    });
    host.registerModule(protocolModule);
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
    registerScriveConnector(host, { baseUrl: BASE, retry: { baseDelayMs: 0 } });

    const principal = principalId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: 'acme', name: 'Acme' });
    for (const key of ['protocol', 'hr']) await host.admin.grantEntitlement(staff, t, key);
    await host.provisionScope(staff, { tenantId: t, scopeId: s, jurisdiction: 'eu', vertical: 'meridian' });
    await host.admin.activateScope(staff, t, s);
    await host.admin.defineRole(staff, t, {
      key: 'hr',
      permissions: [PERM.create, PERM.bind, PERM.requestSignature, PERM.read, PERM.void] as PermissionKey[],
      source: 'vertical',
    });
    await host.admin.assignRole(staff, { principalId: principal, roleKey: 'hr', node: { tenantId: t, scopeId: s } });

    connId = connectionId.parse(ulid());
    await host.admin.createConnection(staff, {
      id: connId,
      tenantId: t,
      vertical: 'meridian',
      provider: 'scrive',
      label: 'Acme Scrive (testbed)',
      secret: { clientId: 'ci', clientSecret: 'cs', tokenId: 'ti', tokenSecret: 'ts' },
    });
    await host.admin.grantToConnection(staff, {
      connectionId: connId,
      permission: PERM.recordSignature,
      node: { tenantId: t, scopeId: s },
      grantedBy: staff,
    });

    stub = await host.getScope(principal, t, s);
    await stub.invoke('protocol/define-template', {
      key: 'anstallningsavtal',
      title: 'Anställningsavtal',
      content: { kind: 'document', documentType: 'anstallningsavtal', hashRecipe: 'sha256 over the terms row' },
    });
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const instantiate = async () => {
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
    return inst.id;
  };

  /** Ask for both signatures; the newest Scrive document is the one this request sent. */
  const request = async (instanceId: string) => {
    const sent = await stub.invoke<{ requests: { id: string }[] }>('protocol/request-signatures', {
      instanceId,
      method: 'scrive',
      parties: [
        { label: 'Arbetsgivare', kind: 'principal', ref: employerRef, signatureKind: 'primary', contact: { email: 'a@example.se' } },
        { label: 'Anställd', kind: 'external', ref: employeeRef, contact: { email: 'b@example.se' } },
      ],
    });
    const docs = [...scrive.documents.values()];
    return { requestIds: sent.requests.map((r) => r.id), docId: docs[docs.length - 1]?.id };
  };

  const issue = async () => {
    const instanceId = await instantiate();
    return { instanceId, ...(await request(instanceId)) };
  };

  const voidIt = (instanceId: string) => stub.invoke('protocol/void', { instanceId, reason: 'superseded' });
  const cancelRequests = (instanceId: string) =>
    stub.invoke('protocol/cancel-signatures', { instanceId, reason: 'a fourth signatory is needed' });
  const row = async (key: string) =>
    (await host.admin.getConnectorState(connId, key)) as ScriveDispatchState | undefined;
  const dispatchState = (instanceId: string) => row(`scrive:dispatch:${instanceId}`);
  const reconcile = (instanceId: string) =>
    reconcileScriveDispatch(host, connId, instanceId, { fetch: scrive.fetch, baseUrl: BASE });
  const sweep = () => sweepScriveReconciliations(host, connId, { fetch: scrive.fetch, baseUrl: BASE });
  const activity = () =>
    scriveConnectionActivity(host, { id: connId, tenantId: t, vertical: 'meridian' }, { fetch: scrive.fetch, baseUrl: BASE });

  it('voiding cancels the document at Scrive, and the sweep stops polling it', async () => {
    const { instanceId, docId } = await issue();
    expect(scrive.documents.get(docId!)!.status).toBe('pending');

    await voidIt(instanceId);

    expect(scrive.documents.get(docId!)!.status).toBe('canceled');
    expect((await dispatchState(instanceId))!.withdrawn).toEqual({
      at: expect.any(String),
      by: 'protocol.voided',
      providerStatus: 'canceled',
    });
    expect(await host.executorDeadLetters(t, s)).toEqual([]);
    expect(await sweep()).toMatchObject({ found: 1, skipped: 1, polled: 0 });
    const { entries } = await activity();
    expect(entries[0]!.status).toBe('withdrawn — protocol voided');
    expect(entries[0]!.facts).toContainEqual({ label: 'At Scrive', value: 'document cancelled' });
  });

  it('a new request after cancelSignatureRequests goes out as a new document', async () => {
    const { instanceId, docId: first } = await issue();
    await cancelRequests(instanceId);
    expect(scrive.documents.get(first!)!.status).toBe('canceled');

    const { requestIds, docId: second } = await request(instanceId);
    expect(second).not.toBe(first);
    const current = await dispatchState(instanceId);
    expect(current!.documentId).toBe(second);
    expect(current!.withdrawn).toBeUndefined();
    // The first document keeps its row, withdrawn, for the activity view.
    expect((await row(`scrive:dispatch:${instanceId}:${first}`))!.withdrawn!.by).toBe('protocol.signatures-cancelled');
    expect((await activity()).entries).toHaveLength(2);

    // And the new document is the one the return path reconciles.
    scrive.sign(second!, 1, '2026-07-21T09:00:00.000Z');
    scrive.sign(second!, 2, '2026-07-21T10:00:00.000Z');
    expect((await reconcile(instanceId)).recorded.map((r) => r.requestId).sort()).toEqual([...requestIds].sort());
    expect(await sweep()).toMatchObject({ found: 2, skipped: 2, polled: 0 });
  });

  it('reads a document Scrive had already ended as settled, with nothing for a person', async () => {
    const { instanceId, docId } = await issue();
    scrive.decline(docId!);

    await voidIt(instanceId);

    const state = await dispatchState(instanceId);
    expect(state!.withdrawn!.providerStatus).toBe('rejected');
    expect(state!.needsAttention).toBeUndefined();
    expect(await host.executorDeadLetters(t, s)).toEqual([]);
  });

  it('a document every party signed before the cancel landed needs a person, and lands no sealed copy', async () => {
    const { instanceId, requestIds, docId } = await issue();
    scrive.sign(docId!, 1, '2026-07-21T09:00:00.000Z');
    scrive.sign(docId!, 2, '2026-07-21T10:00:00.000Z'); // closed at Scrive; not yet polled

    await voidIt(instanceId);

    const state = await dispatchState(instanceId);
    expect(state!.withdrawn!.providerStatus).toBe('closed');
    expect(state!.needsAttention!.map((a) => a.requestId).sort()).toEqual([...requestIds].sort());
    expect(state!.needsAttention![0]!.reason).toMatch(/withdrawn in the scope/);
    expect((await activity()).entries[0]!.status).toBe('needs attention — 2 parties not recorded');

    // An explicit reconcile (a callback) records nothing and stores no sealed copy.
    const result = await reconcile(instanceId);
    expect(result.recorded).toEqual([]);
    expect(result.sealedDocument).toEqual({ skipped: expect.stringMatching(/withdrawn/) });
    expect(result.needsAttention).toHaveLength(2);
    const d = await stub.invoke<ReturnType<typeof getProtocol>>('protocol/get', { instanceId });
    expect(d.signatures).toEqual([]);
  });

  it('tells a signature on a cancelled request from one already recorded', async () => {
    // The cancel cannot reach Scrive yet, so the row is not withdrawn when a party signs.
    const { instanceId, requestIds, docId } = await issue();
    scrive.failOn.cancel = 503;
    await voidIt(instanceId);
    scrive.sign(docId!, 1, '2026-07-21T09:00:00.000Z');

    const result = await reconcile(instanceId);

    expect(result.recorded).toEqual([]);
    expect(result.needsAttention).toEqual([
      { requestId: requestIds[0], signedAt: '2026-07-21T09:00:00.000Z', reason: expect.stringMatching(/withdrawn in the scope/) },
    ]);
    const state = await dispatchState(instanceId);
    expect(state!.recordedRequestIds ?? []).toEqual([]);

    // Once Scrive is reachable the retried delivery cancels it, and the sweep lets it be.
    delete scrive.failOn.cancel;
    await host.drainDue(t, s);
    expect(scrive.documents.get(docId!)!.status).toBe('canceled');
    expect((await dispatchState(instanceId))!.withdrawn!.providerStatus).toBe('canceled');
    expect(await sweep()).toMatchObject({ skipped: 1, polled: 0 });
  });

  it('a request withdrawn before its document went out is never sent', async () => {
    const instanceId = await instantiate();
    scrive.failOn.start = 503; // the dispatch fails, discards its draft, and will retry
    await request(instanceId);
    expect(await dispatchState(instanceId)).toBeUndefined();

    await voidIt(instanceId);
    delete scrive.failOn.start;
    await host.drainDue(t, s);

    expect([...scrive.documents.values()].filter((d) => d.status === 'pending')).toEqual([]);
    expect(await dispatchState(instanceId)).toBeUndefined();
  });

  it('voiding a signed instance leaves its closed document alone', async () => {
    const { instanceId, docId } = await issue();
    scrive.sign(docId!, 1, '2026-07-21T09:00:00.000Z');
    scrive.sign(docId!, 2, '2026-07-21T10:00:00.000Z');
    await reconcile(instanceId);

    await voidIt(instanceId);

    const state = await dispatchState(instanceId);
    expect(state!.withdrawn).toBeUndefined();
    expect(state!.needsAttention).toBeUndefined();
  });

  it('a void in a tenant with no Scrive connection fails no delivery', async () => {
    const instanceId = await instantiate();
    await host.admin.revokeConnection(staff, connId);

    await voidIt(instanceId);

    expect(await host.executorDeadLetters(t, s)).toEqual([]);
    expect((await host.drainDue(t, s)).retrying).toBe(0);
  });
});
