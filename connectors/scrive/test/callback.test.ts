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
import { ulid, webCryptoSecretBox, type FetchLike, type ScopeStub } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { PROTOCOL_PERM as PERM, protocolModule, getProtocol } from '@substrat-run/engine-protocol';
import {
  ScriveMock,
  registerScriveConnector,
  handleScriveCallback,
  scriveCallbackPath,
  type ScriveCallbackRef,
  type ScriveDispatchState,
} from '../src/index.js';

/**
 * The webhook INGRESS (#96): a dispatch mints a capability URL, the provider
 * POSTs it on a signing event, and `handleScriveCallback` verifies the token
 * and runs the same reconcile the poll sweep runs — push beside poll, one
 * driver.
 *
 * The security posture under test is the one connections.md §5 fixed: Scrive's
 * callbacks are unauthenticated, so the minted token is the ENTIRE
 * authentication, a rejection is uniform (no oracle), and a rejected callback
 * causes zero provider egress. Replay needs no seen-set because the callback
 * asserts nothing — it only triggers an idempotent re-read of provider truth.
 */
describe('scrive connector — webhook ingress (capability URL → reconcile)', () => {
  const BASE = 'https://api-testbed.scrive.test';
  const CALLBACK_BASE = 'https://meridian.example';
  let dir: string;
  let host: SqliteScopeHost;
  let scrive: ScriveMock;
  /** Every provider call the connector makes, counted — the no-egress assertions. */
  let egressCalls: number;
  let connId: ReturnType<typeof connectionId.parse>;
  let staff = platformActorId.parse(ulid());
  let t = tenantId.parse(ulid());
  let s = scopeId.parse(ulid());
  let stub: ScopeStub;

  let employerRef = principalId.parse(ulid());
  let employeeRef = dataSubjectId.parse(ulid());

  const EMPLOYEE = { entityType: 'employee', entityId: '01JEMPLOYEE0000000000000AA' };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-scrive-callback-'));
    scrive = new ScriveMock();
    egressCalls = 0;
    const countedFetch: FetchLike = (url, init) => {
      egressCalls += 1;
      return scrive.fetch(url, init);
    };
    staff = platformActorId.parse(ulid());
    t = tenantId.parse(ulid());
    s = scopeId.parse(ulid());
    employerRef = principalId.parse(ulid());
    employeeRef = dataSubjectId.parse(ulid());

    host = new SqliteScopeHost({
      dir,
      secretBox: webCryptoSecretBox('k', new Uint8Array(32).fill(5)),
      fetch: countedFetch,
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
    registerScriveConnector(host, {
      baseUrl: BASE,
      callbackUrl: (ref) => `${CALLBACK_BASE}${scriveCallbackPath(ref)}`,
      retry: { baseDelayMs: 0 },
    });

    const principal = principalId.parse(ulid());
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
      content: {
        kind: 'document',
        documentType: 'anstallningsavtal',
        hashRecipe: 'sha256 over the terms row, fields in fixed order',
      },
    });
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Instantiate → bind → request signatures; returns what the callback path needs. */
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
    const docs = [...scrive.documents.values()];
    const doc = docs[docs.length - 1]!;
    return { instanceId: sent.instance.id, docId: doc.id, callbackUrl: doc.callbackUrl };
  };

  const ledgerRow = async (instanceId: string) =>
    (await host.admin.getConnectorState(connId, `scrive:dispatch:${instanceId}`)) as
      | ScriveDispatchState
      | undefined;

  /** Parse the ref out of the URL the connector registered — as the route would. */
  const refFrom = (callbackUrl: string): ScriveCallbackRef => {
    const m = /\/hooks\/scrive\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(callbackUrl);
    if (!m) throw new Error(`not a callback URL: ${callbackUrl}`);
    return { connectionId: m[1]!, instanceId: m[2]!, token: m[3]! };
  };

  const callback = (ref: ScriveCallbackRef) =>
    handleScriveCallback(host, ref, { fetch: scrive.fetch, baseUrl: BASE });

  it('mints a capability URL at dispatch and remembers its token in the ledger', async () => {
    const { instanceId, callbackUrl } = await issue();

    // The provider got a URL under our base, carrying (connection, instance, token).
    expect(callbackUrl).toBeTruthy();
    const ref = refFrom(callbackUrl!);
    expect(callbackUrl).toBe(`${CALLBACK_BASE}${scriveCallbackPath(ref)}`);
    expect(ref.connectionId).toBe(connId);
    expect(ref.instanceId).toBe(instanceId);
    // 256 bits of hex — unguessable, and never derived from anything readable.
    expect(ref.token).toMatch(/^[0-9a-f]{64}$/);

    // The ledger row holds the same token — the ingress's comparison anchor.
    const row = await ledgerRow(instanceId);
    expect(row?.webhookToken).toBe(ref.token);
  });

  it('accepts a verified callback and records the signatures — the push path end to end', async () => {
    const { instanceId, docId, callbackUrl } = await issue();
    const ref = refFrom(callbackUrl!);

    scrive.sign(docId, 1, '2026-07-21T09:00:00.000Z');
    scrive.sign(docId, 2, '2026-07-21T10:30:00.000Z');

    const outcome = await callback(ref);
    expect(outcome.accepted).toBe(true);
    if (!outcome.accepted) throw new Error('unreachable');
    expect(outcome.result.complete).toBe(true);
    expect(outcome.result.recorded).toHaveLength(2);

    const d = await stub.invoke<ReturnType<typeof getProtocol>>('protocol/get', { instanceId });
    expect(d.instance.status).toBe('signed');
    expect(d.signatures).toHaveLength(2);
  });

  it('a replayed callback is a harmless nudge — idempotent, records nothing new', async () => {
    const { instanceId, docId, callbackUrl } = await issue();
    const ref = refFrom(callbackUrl!);
    scrive.sign(docId, 1, '2026-07-21T09:00:00.000Z');
    scrive.sign(docId, 2, '2026-07-21T10:30:00.000Z');

    const first = await callback(ref);
    expect(first.accepted && first.result.recorded).toHaveLength(2);

    // The provider retries (it does, 10 times) — same URL, later, staler.
    const replay = await callback(ref);
    expect(replay.accepted).toBe(true);
    if (!replay.accepted) throw new Error('unreachable');
    expect(replay.result.recorded).toEqual([]);
    const d = await stub.invoke<ReturnType<typeof getProtocol>>('protocol/get', { instanceId });
    expect(d.signatures).toHaveLength(2);
  });

  it('rejects a wrong token with a uniform answer and ZERO provider egress', async () => {
    const { docId, callbackUrl } = await issue();
    const ref = refFrom(callbackUrl!);
    scrive.sign(docId, 1, '2026-07-21T09:00:00.000Z');
    scrive.sign(docId, 2, '2026-07-21T10:30:00.000Z');

    const before = egressCalls;
    const outcomes = await Promise.all([
      callback({ ...ref, token: 'f'.repeat(64) }), // wrong token
      callback({ ...ref, instanceId: '01JNEVER00000000000000000X' }), // unknown instance
      callback({ ...ref, connectionId: 'not-a-ulid' }), // malformed connection
      callback({ ...ref, connectionId: connectionId.parse(ulid()) }), // unknown connection
    ]);
    for (const o of outcomes) expect(o.accepted).toBe(false);
    // No oracle: every rejection is the same shape to a caller.
    // And none of them reached the provider.
    expect(egressCalls).toBe(before);

    // The signatures were NOT recorded — only a verified callback reconciles.
    const rows = await host.admin.listConnectorState(connId, 'scrive:dispatch:');
    const state = rows[0]!.value as ScriveDispatchState;
    expect(state.recordedRequestIds ?? []).toEqual([]);
  });

  it('a poll-only dispatch (no callbackUrl configured) has no callback door', async () => {
    // A second host, configured without callbackUrl — the pre-#96 shape.
    const dir2 = mkdtempSync(join(tmpdir(), 'substrat-scrive-pollonly-'));
    const scrive2 = new ScriveMock();
    const host2 = new SqliteScopeHost({
      dir: dir2,
      secretBox: webCryptoSecretBox('k', new Uint8Array(32).fill(5)),
      fetch: scrive2.fetch,
    });
    try {
      host2.registerModule(protocolModule);
      host2.registerModule({
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
      registerScriveConnector(host2, { baseUrl: BASE, retry: { baseDelayMs: 0 } });

      const staff2 = platformActorId.parse(ulid());
      const t2 = tenantId.parse(ulid());
      const s2 = scopeId.parse(ulid());
      const p2 = principalId.parse(ulid());
      await host2.admin.createTenant(staff2, { id: t2, slug: 'poll-only', name: 'Poll Only' });
      for (const key of ['protocol', 'hr']) await host2.admin.grantEntitlement(staff2, t2, key);
      await host2.provisionScope(staff2, { tenantId: t2, scopeId: s2, jurisdiction: 'eu', vertical: 'meridian' });
      await host2.admin.activateScope(staff2, t2, s2);
      await host2.admin.defineRole(staff2, t2, {
        key: 'hr',
        permissions: [PERM.create, PERM.bind, PERM.requestSignature] as PermissionKey[],
        source: 'vertical',
      });
      await host2.admin.assignRole(staff2, { principalId: p2, roleKey: 'hr', node: { tenantId: t2, scopeId: s2 } });
      const conn2 = connectionId.parse(ulid());
      await host2.admin.createConnection(staff2, {
        id: conn2,
        tenantId: t2,
        vertical: 'meridian',
        provider: 'scrive',
        label: 'Poll Only Scrive',
        secret: { clientId: 'ci', clientSecret: 'cs', tokenId: 'ti', tokenSecret: 'ts' },
      });

      const stub2 = await host2.getScope(p2, t2, s2);
      await stub2.invoke('protocol/define-template', {
        key: 'anstallningsavtal',
        title: 'Anställningsavtal',
        content: {
          kind: 'document',
          documentType: 'anstallningsavtal',
          hashRecipe: 'sha256 over the terms row, fields in fixed order',
        },
      });
      const inst = await stub2.invoke<{ id: string }>('protocol/instantiate', {
        templateKey: 'anstallningsavtal',
        entityType: EMPLOYEE.entityType,
        entityId: EMPLOYEE.entityId,
      });
      await stub2.invoke('protocol/bind-document', {
        instanceId: inst.id,
        contentRef: { entityType: 'employment-terms', entityId: '01JTERMS000000000000000000' },
        contentHash: 'ab'.repeat(32),
      });
      const sent = await stub2.invoke<{ instance: { id: string } }>('protocol/request-signatures', {
        instanceId: inst.id,
        method: 'scrive',
        parties: [
          { label: 'Arbetsgivare', kind: 'principal', ref: employerRef, signatureKind: 'primary', contact: { email: 'arbetsgivare@example.se' } },
          { label: 'Anställd', kind: 'external', ref: employeeRef, contact: { email: 'anstalld@example.se' } },
        ],
      });

      // No URL went to the provider, no token in the ledger…
      const doc = [...scrive2.documents.values()][0]!;
      expect(doc.callbackUrl).toBeNull();
      const row = (await host2.admin.getConnectorState(
        conn2,
        `scrive:dispatch:${sent.instance.id}`,
      )) as ScriveDispatchState;
      expect(row.webhookToken).toBeUndefined();

      // …so even a caller guessing the RIGHT ids is refused: no token, no door.
      const refused = await handleScriveCallback(
        host2,
        { connectionId: conn2, instanceId: sent.instance.id, token: 'f'.repeat(64) },
        { fetch: scrive2.fetch, baseUrl: BASE },
      );
      expect(refused.accepted).toBe(false);
    } finally {
      await host2.close();
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('the mock delivers a callback on sign — the full provider loop, offline', async () => {
    // Rebuild the mock with delivery wired to the handler, as meridian's server
    // wires it to its route: sign() → provider POST → verify → reconcile. The
    // mock fires and forgets, as a provider would; the test keeps the promises
    // so it can await the deliveries it caused.
    const delivered: string[] = [];
    const deliveries: Promise<unknown>[] = [];
    scrive = new ScriveMock({
      onCallback: (cb) => {
        delivered.push(cb.status);
        deliveries.push(callback(refFrom(cb.url)));
      },
    });

    const { instanceId, docId } = await issue();
    scrive.sign(docId, 1, '2026-07-21T09:00:00.000Z');
    scrive.sign(docId, 2, '2026-07-21T10:30:00.000Z');
    await Promise.all(deliveries);

    expect(delivered).toEqual(['pending', 'closed']);
    const d = await stub.invoke<ReturnType<typeof getProtocol>>('protocol/get', { instanceId });
    expect(d.instance.status).toBe('signed');
    expect(d.signatures).toHaveLength(2);
  });
});
