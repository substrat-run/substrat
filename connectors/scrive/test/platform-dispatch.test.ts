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
  type DomainEvent,
  type PermissionKey,
} from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox, type ScopeStub } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { PROTOCOL_PERM as PERM, protocolModule } from '@substrat-run/engine-protocol';
import {
  ScriveMock,
  scriveConnector,
  scriveCallbackPath,
  type ScriveDispatchState,
} from '../src/index.js';

/**
 * #574 phase 3, the platform half: a CP-less vertical routed a dispatch delivery here
 * as a `connector:scrive` intent, and the platform executes it via
 * `host.dispatchConnector` — the SAME `scriveConnector` closure a self-host registers,
 * against a host that holds the directory and the credential. The event is the real
 * kernel-stamped envelope (captured off the spine, not hand-crafted), so what is
 * proven is that the routed payload is sufficient: nothing the in-process path had is
 * missing. The callback URL is minted from the platform's own origin — the phase-2
 * ingress — because that is where the dispatch now runs.
 */
describe('scrive connector — platform-side dispatch of a routed delivery', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let scrive: ScriveMock;
  let connId: ReturnType<typeof connectionId.parse>;
  let staff = platformActorId.parse(ulid());
  let t = tenantId.parse(ulid());
  let s = scopeId.parse(ulid());
  let stub: ScopeStub;
  /** The routed deliveries — captured by a plain executor, exactly what a CP-less host embeds. */
  let routed: DomainEvent[];

  const EMPLOYEE = { entityType: 'employee', entityId: '01JEMPLOYEE0000000000000AA' };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-scrive-'));
    scrive = new ScriveMock();
    routed = [];

    staff = platformActorId.parse(ulid());
    t = tenantId.parse(ulid());
    s = scopeId.parse(ulid());

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

    // NOT the connector — a capture executor standing in for the CP-less host's routing:
    // it sees the same kernel-stamped envelope `routeExecutorEventToPlatform` embeds.
    host.registerExecutor('capture', 'protocol.signatures-requested', async (_admin, event) => {
      routed.push(event);
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

  const dispatchState = (instanceId: string) =>
    host.admin.getConnectorState(connId, `scrive:dispatch:${instanceId}`) as Promise<
      ScriveDispatchState | undefined
    >;

  /** Instantiate → bind → request signatures; the capture executor records the event. */
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
          { label: 'Anställd', kind: 'external', contact: { email: 'anstalld@example.se' } },
        ],
      },
    );
  };

  // The platform's registration: the CP worker's exact options shape — its own
  // public origin in front of the phase-2 ingress path.
  const platformConnector = () =>
    scriveConnector({
      baseUrl: 'https://api-testbed.scrive.test',
      callbackUrl: (ref) => `https://cp.substrat.test${scriveCallbackPath(ref)}`,
    });

  it('dispatches the routed event with platform authority — document started, ledger written', async () => {
    const sent = await issue();
    expect(scrive.documents.size).toBe(0); // nothing ran in-process
    expect(routed).toHaveLength(1);

    await host.dispatchConnector(t, s, platformConnector(), routed[0]!);

    expect(scrive.documents.size).toBe(1);
    const [doc] = [...scrive.documents.values()];
    expect(doc!.status).toBe('pending');
    expect(doc!.file!.bytes).toBeGreaterThan(0);
    // The capability URL terminates on the PLATFORM's ingress, not the vertical.
    expect(doc!.callbackUrl).toMatch(
      /^https:\/\/cp\.substrat\.test\/hooks\/scrive\/[0-9A-HJKMNP-TV-Z]{26}\/[^/]+\/[0-9a-f]{64}$/,
    );
    expect(doc!.callbackUrl).toContain(sent.instance.id);

    const state = await dispatchState(sent.instance.id);
    expect(state).toBeDefined();
    expect(state!.tenantId).toBe(t);
    expect(state!.scopeId).toBe(s);
    expect(state!.vertical).toBe('meridian');
    expect(state!.webhookToken).toMatch(/^[0-9a-f]{64}$/);
    expect(state!.parties.map((p) => p.requestId)).toEqual(sent.requests.map((r) => r.id));
  });

  it('a re-dispatch of the same routed event is idempotent — the ledger absorbs at-least-once', async () => {
    await issue();
    const connector = platformConnector();
    await host.dispatchConnector(t, s, connector, routed[0]!);
    await host.dispatchConnector(t, s, connector, routed[0]!);
    expect(scrive.documents.size).toBe(1);
  });
});
