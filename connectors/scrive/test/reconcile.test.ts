import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CONNECTOR_ATTACHMENT_BUFFERED_MAX_BYTES,
  connectionActivity,
  connectionId,
  dataSubjectId,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type PermissionKey,
} from '@substrat-run/contracts';
import { isSizedByteStream, runPlatformSweep, ulid, webCryptoSecretBox, type ByteBody, type ScopeStub } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { PROTOCOL_PERM as PERM, protocolModule, getProtocol } from '@substrat-run/engine-protocol';
import {
  ScriveApi,
  SCRIVE_MAX_DOWNLOAD_BYTES,
  ScriveMock,
  registerScriveConnector,
  reconcileScriveDispatch,
  scriveConnectionActivity,
  sweepScriveReconciliations,
  type ScriveDispatchState,
} from '../src/index.js';

/**
 * The RETURN path (#97), end to end: a document is dispatched, parties sign at
 * the provider, and the poll driver records those signatures back onto the
 * protocol instance in the scope — the half the connector could not do until
 * `getConnectorScope` let a connection write into a scope as itself.
 *
 * Runs against `ScriveMock`, whose `sign()` stands in for the provider-side
 * BankID event we cannot cause for real (and which is disabled on the testbed
 * account anyway). What is proven is that the seam is wired correctly: the
 * connection's `protocol:record-signature` grant admits the write, the frozen
 * hash is checked, and the instance transitions to `signed` when the set is
 * complete. What a mock cannot prove — that Scrive's real `get` shapes and party
 * ordering match — waits on a testbed BankID round-trip.
 */
describe('scrive connector — return path (record signatures back)', () => {
  const BASE = 'https://api-testbed.scrive.test';
  let dir: string;
  let host: SqliteScopeHost;
  let scrive: ScriveMock;
  let connId: ReturnType<typeof connectionId.parse>;
  let staff = platformActorId.parse(ulid());
  let t = tenantId.parse(ulid());
  let s = scopeId.parse(ulid());
  let stub: ScopeStub;
  // The signed-in principal (role 'hr', holds protocol:read) — hoisted so a test can
  // read attachments the connection landed but cannot itself list.
  let principal = principalId.parse(ulid());

  // Signatories known up front, so the driver has a ref to attribute each
  // recorded signature to: a principal for the employer, an opaque DataSubjectId
  // for the external employee.
  let employerRef = principalId.parse(ulid());
  let employeeRef = dataSubjectId.parse(ulid());

  const EMPLOYEE = { entityType: 'employee', entityId: '01JEMPLOYEE0000000000000AA' };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-scrive-recon-'));
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

    principal = principalId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: 'nordljus', name: 'Nordljus' });
    for (const key of ['protocol', 'hr']) await host.admin.grantEntitlement(staff, t, key);
    await host.provisionScope(staff, { tenantId: t, scopeId: s, jurisdiction: 'eu', vertical: 'meridian' });
    await host.admin.activateScope(staff, t, s);
    await host.admin.defineRole(staff, t, {
      key: 'hr',
      permissions: [PERM.create, PERM.bind, PERM.requestSignature, PERM.read] as PermissionKey[],
      source: 'vertical',
    });
    await host.admin.assignRole(staff, { principalId: principal, roleKey: 'hr', node: { tenantId: t, scopeId: s } });

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
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Instantiate → bind → request signatures for two known parties, and dispatch.
   * Parametrised by entity so a sweep test can issue more than one (the engine
   * allows only one open protocol per entity).
   */
  const issue = async (
    entityId: string = EMPLOYEE.entityId,
    termsId = '01JTERMS000000000000000000',
  ) => {
    const inst = await stub.invoke<{ id: string }>('protocol/instantiate', {
      templateKey: 'anstallningsavtal',
      entityType: EMPLOYEE.entityType,
      entityId,
    });
    await stub.invoke('protocol/bind-document', {
      instanceId: inst.id,
      contentRef: { entityType: 'employment-terms', entityId: termsId },
      contentHash: 'ab'.repeat(32),
    });
    const sent = await stub.invoke<{ instance: { id: string }; requests: { id: string }[] }>(
      'protocol/request-signatures',
      {
        instanceId: inst.id,
        method: 'scrive',
        parties: [
          { label: 'Arbetsgivare', kind: 'principal', ref: employerRef, signatureKind: 'primary', contact: { email: 'arbetsgivare@example.se' } },
          { label: 'Anställd', kind: 'external', ref: employeeRef, contact: { email: 'anstalld@example.se' } },
        ],
      },
    );
    // The newest document — issue() may be called more than once in a sweep test.
    const docs = [...scrive.documents.values()];
    const doc = docs[docs.length - 1];
    return { instanceId: sent.instance.id, requestIds: sent.requests.map((r) => r.id), docId: doc!.id };
  };

  /**
   * The #97 grant: the connection may record signatures into this scope, and
   * nothing else. Appears in the permission diff like any grant. Applied per
   * test rather than in setup so the negative case can prove it is load-bearing.
   */
  const grantRecordSignature = () =>
    host.admin.grantToConnection(staff, {
      connectionId: connId,
      permission: PERM.recordSignature,
      node: { tenantId: t, scopeId: s },
      grantedBy: staff,
    });

  /** The #476 grant: the connection may attach the sealed PDF to the protocol instance. */
  const grantAttach = () =>
    host.admin.grantToConnection(staff, {
      connectionId: connId,
      permission: PERM.attach,
      node: { tenantId: t, scopeId: s },
      grantedBy: staff,
    });

  const reconcile = (instanceId: string) =>
    reconcileScriveDispatch(host, connId, instanceId, { fetch: scrive.fetch, baseUrl: BASE });

  const sweep = () => sweepScriveReconciliations(host, connId, { fetch: scrive.fetch, baseUrl: BASE });

  const detail = (instanceId: string) => stub.invoke<ReturnType<typeof getProtocol>>('protocol/get', { instanceId });

  it('records both signatures once the provider closes the document', async () => {
    await grantRecordSignature();
    const { instanceId, requestIds, docId } = await issue();

    // Nothing signed yet — a poll is a clean no-op, not an error.
    const early = await reconcile(instanceId);
    expect(early.recorded).toEqual([]);
    expect(early.complete).toBe(false);
    expect(early.documentStatus).toBe('pending');

    // Both parties complete BankID at the provider; the mock closes the document.
    scrive.sign(docId, 1, '2026-07-21T09:00:00.000Z');
    scrive.sign(docId, 2, '2026-07-21T10:30:00.000Z');

    const result = await reconcile(instanceId);
    expect(result.documentStatus).toBe('closed');
    expect(result.complete).toBe(true);
    expect(result.skipped).toEqual([]);
    expect(result.recorded.map((r) => r.requestId).sort()).toEqual([...requestIds].sort());

    // The signatures actually landed in the SCOPE — the whole point of #97.
    const d = await detail(instanceId);
    expect(d.instance.status).toBe('signed');
    expect(d.signatures).toHaveLength(2);
    expect(d.signatures.map((sig) => sig.signed_by).sort()).toEqual([employerRef, employeeRef].sort());
    expect(d.requests.every((r) => r.status === 'signed')).toBe(true);
    // Provider timestamp, not when we heard.
    const employer = d.signatures.find((sig) => sig.signed_by === employerRef);
    expect(employer!.signed_at).toBe('2026-07-21T09:00:00.000Z');
  });

  it('lands the sealed signed PDF as an attachment once the document closes (#476)', async () => {
    await grantRecordSignature();
    await grantAttach();
    await host.provisionBlobStore(staff, { tenantId: t, vertical: 'meridian', binding: 'ATTACHMENTS' });
    const { instanceId, docId } = await issue();

    scrive.sign(docId, 1, '2026-07-21T09:00:00.000Z');
    scrive.sign(docId, 2, '2026-07-21T10:30:00.000Z');

    const result = await reconcile(instanceId);
    expect(result.complete).toBe(true);
    // The sealed PDF was fetched and stored.
    expect(result.sealedDocument).toBeDefined();
    const landed = result.sealedDocument as { attachmentId: string };
    expect(landed.attachmentId).toBeTruthy();

    // It really landed on the protocol instance — read it back as the signed-in
    // principal (who holds protocol:read; the connection itself cannot list).
    const att = await host.attachments(principal, t, s);
    const opened = await att.open(landed.attachmentId);
    expect(opened).not.toBeNull();
    expect(opened!.contentType).toBe('application/pdf');
    // The mock's sealed bytes name the document — proof it pulled files/main.
    expect(new TextDecoder().decode(opened!.body)).toContain(docId);

    // Idempotent: a re-poll does not download or store a second copy.
    const again = await reconcile(instanceId);
    expect(again.sealedDocument).toEqual({ skipped: 'already landed' });
    const list = await att.list({ entityType: 'protocol', entityId: instanceId });
    expect(list).toHaveLength(1);
  });

  it('lands a sealed PDF over the buffered upload bound by a sized stream, and one at the bound as a buffer (#2538)', async () => {
    await grantRecordSignature();
    await grantAttach();
    await host.provisionBlobStore(staff, { tenantId: t, vertical: 'meridian', binding: 'ATTACHMENTS' });
    const { instanceId, docId } = await issue();
    scrive.sign(docId, 1, '2026-07-21T09:00:00.000Z');
    scrive.sign(docId, 2, '2026-07-21T10:30:00.000Z');

    const big = new Uint8Array(CONNECTOR_ATTACHMENT_BUFFERED_MAX_BYTES + 1).fill(9);
    vi.spyOn(ScriveApi.prototype, 'getMainFile').mockResolvedValue(big);
    const bodies: ByteBody[] = [];
    const real = host.getConnectorAttachments.bind(host);
    vi.spyOn(host, 'getConnectorAttachments').mockImplementation(async (...args) => {
      const inner = await real(...args);
      return { ...inner, upload: (input) => (bodies.push(input.body), inner.upload(input)) };
    });

    const result = await reconcile(instanceId);
    expect(result.sealedDocument).toMatchObject({ attachmentId: expect.any(String) });
    expect(bodies).toHaveLength(1);
    expect(isSizedByteStream(bodies[0])).toBe(true);
    // The stored bytes are the PDF's, read back.
    const att = await host.attachments(principal, t, s);
    const opened = await att.open((result.sealedDocument as { attachmentId: string }).attachmentId);
    expect((opened!.body as Uint8Array).byteLength).toBe(big.byteLength);
    expect((opened!.body as Uint8Array)[big.byteLength - 1]).toBe(9);
  });

  describe('a sealed PDF over the download bound (#2552)', () => {
    const MAX = SCRIVE_MAX_DOWNLOAD_BYTES;
    /** A passive pass: the hold is honoured while the document is unchanged. */
    const passive = (instanceId: string) =>
      reconcileScriveDispatch(host, connId, instanceId, { fetch: scrive.fetch, baseUrl: BASE, honourHeld: true });
    const ledgerOf = async (instanceId: string) =>
      (await host.admin.getConnectorState(connId, `scrive:dispatch:${instanceId}`)) as ScriveDispatchState;

    /** A closed document whose sealed file the mock declares as `declared` bytes. */
    async function closedWith(declared: number | null, actual: number) {
      await grantRecordSignature();
      await grantAttach();
      await host.provisionBlobStore(staff, { tenantId: t, vertical: 'meridian', binding: 'ATTACHMENTS' });
      const { instanceId, docId } = await issue();
      scrive.sign(docId, 1, '2026-07-21T09:00:00.000Z');
      scrive.sign(docId, 2, '2026-07-21T10:30:00.000Z');
      scrive.setSealedFile(docId, { declared, actual });
      return { instanceId, docId };
    }
    const fetches = () => vi.spyOn(ScriveApi.prototype, 'getMainFile');
    const upload = () => {
      const real = host.getConnectorAttachments.bind(host);
      const calls: number[] = [];
      vi.spyOn(host, 'getConnectorAttachments').mockImplementation(async (...args) => {
        const inner = await real(...args);
        return { ...inner, upload: (input) => (calls.push(1), inner.upload(input)) };
      });
      return calls;
    };

    it('skips it without reading the body, reports why, and holds the decision across polls', async () => {
      const { instanceId, docId } = await closedWith(MAX + 1, 8);
      const spy = fetches();
      const uploads = upload();

      const first = await reconcile(instanceId);
      expect(first.complete).toBe(true);
      expect(first.sealedDocument).toEqual({ skipped: expect.stringMatching(/larger than this connector downloads/) });
      expect(scrive.sealedBytesServed.get(docId) ?? 0).toBe(0);
      expect(uploads).toHaveLength(0);
      expect((await ledgerOf(instanceId)).sealedHeld).toMatchObject({ reason: expect.stringContaining(String(MAX + 1)) });
      expect(spy).toHaveBeenCalledTimes(1);

      // The document is as it was: the next polls report the same reason and fetch nothing.
      const again = await passive(instanceId);
      const third = await passive(instanceId);
      expect(again.sealedDocument).toEqual(first.sealedDocument);
      expect(third.sealedDocument).toEqual(first.sealedDocument);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('an explicit reconcile, or a callback, clears the hold and tries again on an unchanged document', async () => {
      const { instanceId, docId } = await closedWith(MAX + 1, 8);
      const spy = fetches();
      await reconcile(instanceId);
      await passive(instanceId);
      expect(spy).toHaveBeenCalledTimes(1);

      // Nothing changed at the provider; an operator asks again, and the file is now takeable.
      scrive.setSealedFile(docId, { declared: 8, actual: 8 });
      const forced = await reconcile(instanceId);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(forced.sealedDocument).toMatchObject({ attachmentId: expect.any(String) });
      expect((await ledgerOf(instanceId)).sealedHeld).toBeUndefined();
    });

    it('tries again when the provider reports the document changed, and clears the hold once it lands', async () => {
      const { instanceId, docId } = await closedWith(MAX + 1, 8);
      const spy = fetches();
      await reconcile(instanceId);
      expect(spy).toHaveBeenCalledTimes(1);

      // Re-presented: the document changed at the provider and the file is now one the connector can take.
      scrive.touch(docId);
      scrive.setSealedFile(docId, { declared: 8, actual: 8 });
      const retried = await passive(instanceId);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(retried.sealedDocument).toMatchObject({ attachmentId: expect.any(String) });
      const row = await ledgerOf(instanceId);
      expect(row.sealedHeld).toBeUndefined();
      expect(row.sealedAttachmentId).toBe((retried.sealedDocument as { attachmentId: string }).attachmentId);
    });

    it('holds again, under the new mtime, when a changed document is still too large', async () => {
      const { instanceId, docId } = await closedWith(MAX + 1, 8);
      const spy = fetches();
      await reconcile(instanceId);
      const before = (await ledgerOf(instanceId)).sealedHeld;
      scrive.touch(docId);
      await passive(instanceId);
      expect(spy).toHaveBeenCalledTimes(2);
      const after = (await ledgerOf(instanceId)).sealedHeld;
      expect(after?.mtime).toBeDefined();
      expect(after?.mtime).not.toBe(before?.mtime);
      await passive(instanceId);
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('takes a file declared at the ceiling and refuses one declared a byte over', async () => {
      const at = await closedWith(MAX, 8);
      const landed = await reconcile(at.instanceId);
      expect(landed.sealedDocument).toMatchObject({ attachmentId: expect.any(String) });
      expect((await ledgerOf(at.instanceId)).sealedHeld).toBeUndefined();

      const over = await closedWith(MAX + 1, 8);
      const refused = await reconcile(over.instanceId);
      expect(refused.sealedDocument).toEqual({ skipped: expect.any(String) });
      expect((await ledgerOf(over.instanceId)).sealedHeld).toBeDefined();
    });

    it('cuts off a body that declares no length at the ceiling and holds it', async () => {
      const CHUNK = 1024 * 1024; // the mock serves in 1 MiB reads
      const total = 2 * MAX;
      const { instanceId, docId } = await closedWith(null, total);
      const first = await reconcile(instanceId);
      expect(first.sealedDocument).toEqual({ skipped: expect.stringMatching(/larger than this connector downloads/) });
      expect(scrive.sealedBytesServed.get(docId)).toBeLessThanOrEqual(MAX + CHUNK);
      expect(scrive.sealedBytesServed.get(docId)).toBeLessThan(total);
      expect(scrive.sealedCancelled.has(docId)).toBe(true);
      const spy = fetches();
      await passive(instanceId);
      expect(spy).not.toHaveBeenCalled();
    });

    it('does not hold a transient failure: the next poll fetches again', async () => {
      const { instanceId } = await closedWith(8, 8);
      const spy = vi.spyOn(ScriveApi.prototype, 'getMainFile').mockRejectedValueOnce(new Error('egress hiccup'));
      const failed = await reconcile(instanceId);
      expect(failed.sealedDocument).toEqual({ skipped: 'egress hiccup' });
      expect((await ledgerOf(instanceId)).sealedHeld).toBeUndefined();
      const next = await reconcile(instanceId);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(next.sealedDocument).toMatchObject({ attachmentId: expect.any(String) });
    });

    it('shows a held file on the activity view', async () => {
      const { instanceId } = await closedWith(MAX + 1, 8);
      await reconcile(instanceId);
      const view = await scriveConnectionActivity(host, { id: connId, tenantId: t, vertical: 'meridian' }, { fetch: scrive.fetch, baseUrl: BASE });
      const rows = JSON.stringify(view.entries);
      expect(rows).toContain('not stored');
    });
  });

  it('records incrementally and is idempotent across polls', async () => {
    await grantRecordSignature();
    const { instanceId, requestIds, docId } = await issue();
    const [primaryReq] = requestIds;

    // Only the employer has signed.
    scrive.sign(docId, 1, '2026-07-21T09:00:00.000Z');
    const first = await reconcile(instanceId);
    expect(first.recorded.map((r) => r.requestId)).toEqual([primaryReq]);
    expect(first.complete).toBe(false);
    expect((await detail(instanceId)).instance.status).toBe('pending_signature');

    // Re-polling the same half-signed set records nothing new.
    const repeat = await reconcile(instanceId);
    expect(repeat.recorded).toEqual([]);
    expect(repeat.complete).toBe(false);
    expect((await detail(instanceId)).signatures).toHaveLength(1);

    // The employee signs; the next poll records only the newcomer and completes.
    scrive.sign(docId, 2, '2026-07-21T10:30:00.000Z');
    const second = await reconcile(instanceId);
    expect(second.recorded.map((r) => r.requestId)).toEqual([requestIds[1]]);
    expect(second.complete).toBe(true);
    expect((await detail(instanceId)).instance.status).toBe('signed');
  });

  it('refuses to record when the connection lacks the grant', async () => {
    // No grantRecordSignature() here — the connection was never allowed to write.
    const { instanceId, docId } = await issue();
    scrive.sign(docId, 1, '2026-07-21T09:00:00.000Z');
    scrive.sign(docId, 2, '2026-07-21T10:30:00.000Z');

    // getConnectorScope admits the connection (right tenant, right vertical), but
    // record-signature's own permission check fails closed without the grant.
    await expect(reconcile(instanceId)).rejects.toThrow();
    expect((await detail(instanceId)).signatures).toHaveLength(0);
  });

  it('throws for an instance that was never dispatched', async () => {
    await expect(reconcile('01JNEVER00000000000000000X')).rejects.toThrow(/no scrive dispatch/i);
  });

  // --- the scheduler's unit of work: sweep every outstanding dispatch (#96) ---

  it('sweeps outstanding dispatches, completing the signed and leaving the rest', async () => {
    await grantRecordSignature();
    const a = await issue('employee-a', '01JTERMS0000000000000000A0');
    const b = await issue('employee-b', '01JTERMS0000000000000000B0');

    // A signs fully; B only its first party.
    scrive.sign(a.docId, 1, '2026-07-21T09:00:00.000Z');
    scrive.sign(a.docId, 2, '2026-07-21T10:00:00.000Z');
    scrive.sign(b.docId, 1, '2026-07-21T09:30:00.000Z');

    const first = await sweep();
    expect(first.found).toBe(2);
    expect(first.polled).toBe(2);
    expect(first.skipped).toBe(0);
    expect(first.failed).toEqual([]);
    expect(first.completed).toEqual([a.instanceId]);
    expect(first.outstanding).toEqual([b.instanceId]);
    expect((await detail(a.instanceId)).instance.status).toBe('signed');
    expect((await detail(b.instanceId)).instance.status).toBe('pending_signature');

    // B's second party signs. A re-sweep completes B and does NOT re-poll A —
    // the ledger already shows A fully recorded.
    scrive.sign(b.docId, 2, '2026-07-21T11:00:00.000Z');
    const second = await sweep();
    expect(second.found).toBe(2);
    expect(second.skipped).toBe(1); // A: settled, not re-fetched
    expect(second.polled).toBe(1);
    expect(second.completed).toEqual([b.instanceId]);
    expect((await detail(b.instanceId)).instance.status).toBe('signed');

    // Steady state: everything done, nothing polled.
    const third = await sweep();
    expect(third).toMatchObject({ found: 2, skipped: 2, polled: 0, completed: [], outstanding: [] });
  });

  it('is a clean no-op when nothing is dispatched yet', async () => {
    const empty = await sweep();
    expect(empty).toMatchObject({ found: 0, skipped: 0, polled: 0, completed: [], outstanding: [], failed: [] });
  });

  // --- the platform driver over the sweep: enumerate the fleet, drain + reconcile (#96 Design A) ---

  it('runPlatformSweep drives the connector sweep across the fleet', async () => {
    await grantRecordSignature();
    const { instanceId, docId } = await issue();
    scrive.sign(docId, 1, '2026-07-21T09:00:00.000Z');
    scrive.sign(docId, 2, '2026-07-21T10:00:00.000Z');

    // The scheduler's unit of work: it discovers the scope (drainDue) and the
    // scrive connection (via the injected sweeper) from the directory — nobody
    // hands it the instance id.
    const report = await runPlatformSweep(host, {
      actor: staff,
      fetch: scrive.fetch,
      // The deployment binds its provider base into the sweeper — `baseUrl` is
      // required with no default (#990), so a plane cannot poll the testbed by
      // omission the way production once did (#610).
      sweepers: { scrive: (h, id, o) => sweepScriveReconciliations(h, id, { ...o, baseUrl: BASE }) },
    });

    expect(report.connectionsSwept).toBe(1);
    expect(report.connectionsSkipped).toBe(0);
    expect(report.scopesDrained).toBeGreaterThanOrEqual(1);
    expect(report.errors).toEqual([]);
    // The signature landed in the scope — end to end, driver included.
    expect((await detail(instanceId)).instance.status).toBe('signed');
  });

  /**
   * #1927: a party's name and address are both editable at Scrive, and the reconcile
   * used to key on position with the name as a cross-check — so a routine correction
   * at the provider unhooked a signature from its request, silently, on every poll.
   * Scrive's party id survives the edit; these pin that the ledger keeps it and the
   * reconcile matches on it, and that what still cannot be attributed is visible.
   */
  describe('matching on Scrive party ids (#1927)', () => {
    const ledgerKey = (instanceId: string) => `scrive:dispatch:${instanceId}`;
    const ledger = async (instanceId: string) =>
      (await host.admin.getConnectorState(connId, ledgerKey(instanceId))) as ScriveDispatchState;
    /** Rewrite the row as a dispatch made before the ledger kept provider ids. */
    const asLegacy = async (instanceId: string) => {
      const row = await ledger(instanceId);
      await host.admin.putConnectorState(connId, ledgerKey(instanceId), {
        ...row,
        parties: row.parties.map(({ providerPartyId: _id, ...p }) => p),
      });
    };
    const activity = () =>
      scriveConnectionActivity(host, { id: connId, tenantId: t, vertical: 'meridian' }, {
        fetch: scrive.fetch,
        baseUrl: BASE,
      });

    it('keeps each party’s provider id from the dispatch', async () => {
      const { instanceId, docId } = await issue();
      const row = await ledger(instanceId);
      const provider = scrive.documents.get(docId)!.parties;
      // Party 0 is the non-signing sender; the signatories follow it.
      expect(row.parties.map((p) => p.providerPartyId)).toEqual([provider[1]!.id, provider[2]!.id]);
    });

    it('records a signature whose party was renamed and re-addressed at Scrive', async () => {
      await grantRecordSignature();
      const { instanceId, requestIds, docId } = await issue();

      // The production shape: the invitation address was mistyped, someone corrected
      // the party in Scrive's own UI, and the name field came back different too.
      scrive.editParty(docId, 2, { name: 'anstalld.person', email: 'anstalld.person@example.se' });
      scrive.sign(docId, 2, '2026-07-21T10:30:00.000Z');

      const result = await reconcile(instanceId);
      expect(result.skipped).toEqual([]);
      expect(result.needsAttention).toEqual([]);
      expect(result.recorded).toEqual([{ requestId: requestIds[1], signedAt: '2026-07-21T10:30:00.000Z' }]);
      const d = await detail(instanceId);
      // Attributed to the dispatched signatory, not to whatever the provider now calls it.
      expect(d.signatures.map((sig) => sig.signed_by)).toEqual([employeeRef]);
    });

    it('pins ids on a pre-#1927 dispatch whose shape still lines up, then records it', async () => {
      await grantRecordSignature();
      const { instanceId, requestIds, docId } = await issue();
      await asLegacy(instanceId);

      scrive.editParty(docId, 2, { name: 'anstalld.person' });
      scrive.sign(docId, 2, '2026-07-21T10:30:00.000Z');

      const result = await reconcile(instanceId);
      expect(result.recorded.map((r) => r.requestId)).toEqual([requestIds[1]]);
      expect(result.needsAttention).toEqual([]);
      const provider = scrive.documents.get(docId)!.parties;
      expect((await ledger(instanceId)).parties.map((p) => p.providerPartyId)).toEqual([
        provider[1]!.id,
        provider[2]!.id,
      ]);
    });

    it('shows a signature it cannot attribute instead of skipping it silently', async () => {
      await grantRecordSignature();
      const { instanceId, requestIds, docId } = await issue();
      await asLegacy(instanceId);

      // A document that no longer has the dispatched shape — an extra party — leaves
      // position as the only key, and the edited name refuses it.
      const doc = scrive.documents.get(docId)!;
      doc.parties.push({ ...doc.parties[2]!, id: `${docId}-extra`, name: 'Extra' });
      scrive.editParty(docId, 2, { name: 'anstalld.person' });
      scrive.sign(docId, 2, '2026-07-21T10:30:00.000Z');

      const result = await reconcile(instanceId);
      expect(result.recorded).toEqual([]);
      expect(result.needsAttention).toEqual([
        expect.objectContaining({ requestId: requestIds[1], signedAt: '2026-07-21T10:30:00.000Z' }),
      ]);
      // Durable on the row, where the activity view reads it…
      expect((await ledger(instanceId)).needsAttention).toHaveLength(1);
      const [entry] = (await activity()).entries;
      expect(entry!.status).toMatch(/^needs attention/);
      expect(entry!.facts.find((f) => f.label === 'Anställd')!.value).toMatch(/^signed at Scrive, not recorded/);
      // …and reported by the sweep, so a sweeper can log it.
      const swept = await sweep();
      expect(swept.needsAttention).toEqual([
        expect.objectContaining({ instanceId, requestId: requestIds[1] }),
      ]);

      // Once it is resolved, the flag clears itself.
      doc.parties.pop();
      const fixed = await reconcile(instanceId);
      expect(fixed.recorded.map((r) => r.requestId)).toEqual([requestIds[1]]);
      expect(fixed.needsAttention).toEqual([]);
      expect((await ledger(instanceId)).needsAttention).toBeUndefined();
    });

    it('keeps an attention row inside the activity contract however long the names are', async () => {
      await grantRecordSignature();
      const { instanceId, docId } = await issue();
      await asLegacy(instanceId);
      const doc = scrive.documents.get(docId)!;
      doc.parties.push({ ...doc.parties[2]!, id: `${docId}-extra`, name: 'Extra' });
      scrive.editParty(docId, 2, { name: 'x'.repeat(600) });
      scrive.sign(docId, 2, '2026-07-21T10:30:00.000Z');
      await reconcile(instanceId);

      // The shape the activity route parses with — a value over 400 used to fail the read.
      const parsed = connectionActivity.safeParse(await activity());
      expect(parsed.success).toBe(true);
      const fact = parsed.data!.entries[0]!.facts.find((f) => f.label === 'Anställd')!;
      expect(fact.value).toMatch(/^signed at Scrive, not recorded/);
      expect(fact.value.length).toBeLessThanOrEqual(400);
    });

    /**
     * A pre-#1927 dispatch has no ids, so the first poll pins them by position — and
     * position means something only while the NAMES bear it out. Two parties that
     * changed places keep the count and the roles; two parties renamed at once look
     * exactly like that. Provider party 1 is Arbetsgivare (requestIds[0], employerRef)
     * and 2 is Anställd (requestIds[1], employeeRef) as dispatched; party 0 is the sender.
     */
    describe('pinning a legacy dispatch by position', () => {
      const stored = async (instanceId: string) =>
        (await ledger(instanceId)).parties.map((p) => p.providerPartyId);
      const signers = async (instanceId: string) =>
        (await detail(instanceId)).signatures.map((sig) => [sig.request_id, sig.signed_by]);

      it('pins the ids when the shape and every name still agree', async () => {
        await grantRecordSignature();
        const { instanceId, docId } = await issue();
        await asLegacy(instanceId);

        const result = await reconcile(instanceId);
        expect(result.needsAttention).toEqual([]);
        const provider = scrive.documents.get(docId)!.parties;
        expect(await stored(instanceId)).toEqual([provider[1]!.id, provider[2]!.id]);
      });

      it('still pins when the sender slot shows a signatory’s name — the account holder may be the issuer', async () => {
        await grantRecordSignature();
        const { instanceId, requestIds, docId } = await issue();
        await asLegacy(instanceId);
        // Scrive rewrites the sender to the account holder; here that person is also the
        // issuing signatory the vertical named. The sender never signs, so it is no rival.
        scrive.editParty(docId, 0, { name: 'Arbetsgivare' });
        scrive.sign(docId, 1, '2026-07-21T09:00:00.000Z');

        const result = await reconcile(instanceId);
        expect(result.needsAttention).toEqual([]);
        expect(result.recorded.map((r) => r.requestId)).toEqual([requestIds[0]]);
        const provider = scrive.documents.get(docId)!.parties;
        expect(await stored(instanceId)).toEqual([provider[1]!.id, provider[2]!.id]);
      });

      it('attributes by a name only the sender shares when the shape has changed', async () => {
        await grantRecordSignature();
        const { instanceId, requestIds, docId } = await issue();
        await asLegacy(instanceId);
        const doc = scrive.documents.get(docId)!;
        doc.parties.push({ ...doc.parties[2]!, id: 'extra-party', name: 'Extra' });
        scrive.editParty(docId, 0, { name: 'Arbetsgivare' });
        scrive.sign(docId, 1, '2026-07-21T09:00:00.000Z');

        const result = await reconcile(instanceId);
        expect(result.needsAttention).toEqual([]);
        expect(result.recorded.map((r) => r.requestId)).toEqual([requestIds[0]]);
      });

      it('still pins a single rename when only the sender shows the renamed party’s label', async () => {
        await grantRecordSignature();
        const { instanceId, requestIds, docId } = await issue();
        await asLegacy(instanceId);
        // The account holder is the issuer: the sender slot shows 'Arbetsgivare', and
        // the issuer's own signatory slot was renamed. The sender is no rival.
        scrive.editParty(docId, 0, { name: 'Arbetsgivare' });
        scrive.editParty(docId, 1, { name: 'arbetsgivare.person' });
        scrive.sign(docId, 1, '2026-07-21T09:00:00.000Z');

        const result = await reconcile(instanceId);
        expect(result.needsAttention).toEqual([]);
        expect(result.recorded.map((r) => r.requestId)).toEqual([requestIds[0]]);
      });

      it('does not pin two parties that share a label, even with every name unchanged', async () => {
        await grantRecordSignature();
        const { instanceId, requestIds, docId } = await issue();
        await asLegacy(instanceId);
        // Both dispatched as 'Anställd' — rewritten onto the row, since the point is the
        // ledger's view — and both still show it. Had they swapped places, nothing here
        // would differ, so position cannot say which request is which.
        const row = await ledger(instanceId);
        await host.admin.putConnectorState(connId, ledgerKey(instanceId), {
          ...row,
          parties: row.parties.map((p) => ({ ...p, label: 'Anställd' })),
        });
        scrive.editParty(docId, 1, { name: 'Anställd' });
        scrive.sign(docId, 2, '2026-07-21T10:30:00.000Z');

        const result = await reconcile(instanceId);
        expect(result.recorded).toEqual([]);
        expect(await stored(instanceId)).toEqual([undefined, undefined]);
        expect(result.needsAttention).toEqual([
          expect.objectContaining({ requestId: requestIds[1], signedAt: '2026-07-21T10:30:00.000Z' }),
        ]);
        expect((await ledger(instanceId)).needsAttention).toHaveLength(1);
      });

      it('does not pin a rename when another signing party still shows the same label', async () => {
        await grantRecordSignature();
        const { instanceId, requestIds, docId } = await issue();
        await asLegacy(instanceId);
        // Two dispatched parties that share a label — rewritten onto the row, since the
        // point is the ledger's view. One is renamed at Scrive; the other still shows
        // the shared label, so position is the only thing telling them apart.
        const row = await ledger(instanceId);
        await host.admin.putConnectorState(connId, ledgerKey(instanceId), {
          ...row,
          parties: row.parties.map((p) => ({ ...p, label: 'Anställd' })),
        });
        scrive.sign(docId, 1, '2026-07-21T09:00:00.000Z');

        const result = await reconcile(instanceId);
        expect(result.recorded).toEqual([]);
        expect(await stored(instanceId)).toEqual([undefined, undefined]);
        expect(result.needsAttention.map((a) => a.requestId)).toEqual([requestIds[0]]);
      });

      it('does not pin two parties that changed places, and surfaces the signature', async () => {
        await grantRecordSignature();
        const { instanceId, requestIds, docId } = await issue();
        await asLegacy(instanceId);
        // Names unchanged; Anställd now sits where Arbetsgivare was sent — and signs.
        scrive.reorderParties(docId, [0, 2, 1]);
        scrive.sign(docId, 1, '2026-07-21T10:30:00.000Z');

        const result = await reconcile(instanceId);
        // By position this would credit Anställd's signature to Arbetsgivare.
        expect(result.recorded).toEqual([]);
        expect(await signers(instanceId)).toEqual([]);
        expect(await stored(instanceId)).toEqual([undefined, undefined]);
        expect(result.needsAttention).toEqual([
          expect.objectContaining({ requestId: requestIds[0], signedAt: '2026-07-21T10:30:00.000Z' }),
        ]);
        expect((await ledger(instanceId)).needsAttention).toHaveLength(1);
      });

      it('does not pin when two names differ, and surfaces both signatures', async () => {
        await grantRecordSignature();
        const { instanceId, requestIds, docId } = await issue();
        await asLegacy(instanceId);
        scrive.editParty(docId, 1, { name: 'Namn Ett' });
        scrive.editParty(docId, 2, { name: 'Namn Två' });
        scrive.sign(docId, 1, '2026-07-21T09:00:00.000Z');
        scrive.sign(docId, 2, '2026-07-21T10:30:00.000Z');

        const result = await reconcile(instanceId);
        expect(result.recorded).toEqual([]);
        expect(await stored(instanceId)).toEqual([undefined, undefined]);
        expect(result.needsAttention.map((a) => a.requestId)).toEqual(requestIds);
      });

      it('does not pin a swap followed by one rename onto the other party’s label', async () => {
        await grantRecordSignature();
        const { instanceId, requestIds, docId } = await issue();
        await asLegacy(instanceId);
        // One name differs by count — but the renamed slot now shows 'Anställd', which
        // is the other request's label, and that label is on two provider parties.
        scrive.reorderParties(docId, [0, 2, 1]);
        scrive.editParty(docId, 2, { name: 'Anställd' });
        scrive.sign(docId, 1, '2026-07-21T10:30:00.000Z');

        const result = await reconcile(instanceId);
        expect(result.recorded).toEqual([]);
        expect(await stored(instanceId)).toEqual([undefined, undefined]);
        expect(result.needsAttention.map((a) => a.requestId)).toEqual([requestIds[0]]);
      });

      it('pins a single renamed party to the right request, then follows the id', async () => {
        await grantRecordSignature();
        const { instanceId, requestIds, docId } = await issue();
        await asLegacy(instanceId);
        scrive.editParty(docId, 2, { name: 'anstalld.person' });

        await reconcile(instanceId); // nothing signed yet — pins
        const provider = scrive.documents.get(docId)!.parties;
        expect(await stored(instanceId)).toEqual([provider[1]!.id, provider[2]!.id]);

        // Pinned now: a later reorder no longer matters.
        scrive.reorderParties(docId, [0, 2, 1]);
        scrive.sign(docId, 1, '2026-07-21T10:30:00.000Z'); // Anställd
        const result = await reconcile(instanceId);
        expect(result.recorded.map((r) => r.requestId)).toEqual([requestIds[1]]);
        expect(await signers(instanceId)).toEqual([[requestIds[1], employeeRef]]);
      });

      it('does not pin an intact shape whose one differing slot shows no name', async () => {
        await grantRecordSignature();
        const { instanceId, requestIds, docId } = await issue();
        await asLegacy(instanceId);
        // Shape intact and only one slot differs — but it differs by showing no name,
        // which is no evidence it is still the party dispatched there.
        scrive.editParty(docId, 2, { name: null });
        scrive.sign(docId, 2, '2026-07-21T10:30:00.000Z');

        const result = await reconcile(instanceId);
        expect(result.recorded).toEqual([]);
        expect(await stored(instanceId)).toEqual([undefined, undefined]);
        expect(result.needsAttention).toEqual([
          expect.objectContaining({ requestId: requestIds[1], signedAt: '2026-07-21T10:30:00.000Z' }),
        ]);
      });

      it('does not attribute an unnamed party by position when the shape has changed', async () => {
        await grantRecordSignature();
        const { instanceId, requestIds, docId } = await issue();
        await asLegacy(instanceId);
        // An extra party breaks the shape, so nothing pins and position is all that is
        // left — and the slot shows no name at all, which is no evidence of anything.
        const doc = scrive.documents.get(docId)!;
        doc.parties.push({ ...doc.parties[2]!, id: 'extra-party', name: 'Extra' });
        scrive.editParty(docId, 2, { name: null });
        scrive.sign(docId, 2, '2026-07-21T10:30:00.000Z');

        const result = await reconcile(instanceId);
        expect(result.recorded).toEqual([]);
        expect(result.needsAttention).toEqual([
          expect.objectContaining({ requestId: requestIds[1], signedAt: '2026-07-21T10:30:00.000Z' }),
        ]);
        expect(result.needsAttention[0]!.reason).toMatch(/unnamed/);
      });

      it('does not attribute by a name two provider parties share when the shape has changed', async () => {
        await grantRecordSignature();
        const { instanceId, requestIds, docId } = await issue();
        await asLegacy(instanceId);
        const doc = scrive.documents.get(docId)!;
        doc.parties.push({ ...doc.parties[2]!, id: 'extra-party', name: 'Anställd' });
        scrive.sign(docId, 2, '2026-07-21T10:30:00.000Z');

        const result = await reconcile(instanceId);
        expect(result.recorded).toEqual([]);
        expect(result.needsAttention.map((a) => a.requestId)).toEqual([requestIds[1]]);
      });
    });

    it('flags a pinned party the provider no longer shows', async () => {
      await grantRecordSignature();
      const { instanceId, requestIds, docId } = await issue();
      scrive.documents.get(docId)!.parties.splice(2, 1);

      const result = await reconcile(instanceId);
      expect(result.needsAttention).toEqual([
        expect.objectContaining({ requestId: requestIds[1], signedAt: null }),
      ]);
      // Not a signature, so not in `skipped` — that list stays "signed but not recorded".
      expect(result.skipped).toEqual([]);
    });
  });
});
