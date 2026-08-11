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
import { ulid, webCryptoSecretBox, type ScopeStub } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { PROTOCOL_PERM as PERM, protocolModule } from '@substrat-run/engine-protocol';
import {
  ScriveMock,
  probeScriveConnection,
  probeScriveSecret,
  registerScriveConnector,
  scriveCallbackPath,
  scriveConnectionActivity,
  scriveCredentialSummary,
} from '../src/index.js';

/**
 * The INSPECTION half (#605): asking a live connection what it is and what it has done.
 *
 * These are the two reads a console needs and the platform could not answer. Health
 * (§3.7) keeps one line, last-write-wins, and `openConnection` is deliberately
 * unaudited — so before this, "did the Scrive integration ever do anything?" had no
 * answer short of the platform worker's logs.
 *
 * Against `ScriveMock`, so what is proven is our shape. The one thing a mock cannot
 * settle — that `getprofile` and `documents/list` exist and return what we parse — is
 * settled in `live.test.ts` against the real testbed.
 */
describe('scrive connector — inspection (probe + activity)', () => {
  const BASE = 'https://api-testbed.scrive.test';
  let dir: string;
  let host: SqliteScopeHost;
  let scrive: ScriveMock;
  let connId: ReturnType<typeof connectionId.parse>;
  let staff = platformActorId.parse(ulid());
  let t = tenantId.parse(ulid());
  let s = scopeId.parse(ulid());
  let stub: ScopeStub;

  const EMPLOYEE = { entityType: 'employee', entityId: '01JEMPLOYEE0000000000000AA' };
  /** The identity half of the connection — what both reads take. */
  const ref = () => ({ id: connId, tenantId: t as string, vertical: 'meridian' });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-scrive-inspect-'));
    scrive = new ScriveMock();
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
    registerScriveConnector(host, {
      baseUrl: BASE,
      callbackUrl: (r) => `https://vertical.test${scriveCallbackPath(r)}`,
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

  /** Instantiate → bind → request signatures, which dispatches one Scrive document. */
  const issue = async (entityId: string = EMPLOYEE.entityId) => {
    const inst = await stub.invoke<{ id: string }>('protocol/instantiate', {
      templateKey: 'anstallningsavtal',
      entityType: EMPLOYEE.entityType,
      entityId,
    });
    await stub.invoke('protocol/bind-document', {
      instanceId: inst.id,
      contentRef: { entityType: 'employment-terms', entityId: '01JTERMS000000000000000000' },
      contentHash: 'ab'.repeat(32),
    });
    return stub.invoke<{ instance: { id: string }; requests: { id: string }[] }>('protocol/request-signatures', {
      instanceId: inst.id,
      method: 'scrive',
      parties: [
        { label: 'Arbetsgivare', kind: 'principal', signatureKind: 'primary' },
        { label: 'Anställd', kind: 'external' },
      ],
    });
  };

  it('probes the credential and names the account it acts as', async () => {
    const probe = await probeScriveConnection(host, ref(), { fetch: scrive.fetch, baseUrl: BASE });

    expect(probe.ok).toBe(true);
    expect(probe.error).toBeNull();
    // The company id is what `externalAccountRef` means for this provider — the value
    // that lets a console say "these keys are for a different Scrive company".
    expect(probe.accountRef).toBe('30338661');
    expect(probe.accountLabel).toContain('Mock Company');
    expect(probe.facts.map((f) => f.label)).toContain('Company');
    // Which Scrive was asked, on every answer — see the failure case below for why.
    expect(probe.facts).toContainEqual({ label: 'Environment', value: 'testbed (api-testbed.scrive.test)' });
    // A probe is a USE: it rides the connection-bound fetch, so health lands on it.
    const [row] = await host.admin.listConnections(staff, { tenantId: t });
    expect(row!.lastOkAt).not.toBeNull();
  });

  it('reports a refused credential as an answer, not a failure', async () => {
    scrive.failWith = 401;

    const probe = await probeScriveConnection(host, ref(), { fetch: scrive.fetch, baseUrl: BASE });

    // The whole point: the provider's own words, so 'this feature is disabled' does
    // not read the same as 'your keys are wrong'.
    expect(probe.ok).toBe(false);
    expect(probe.error).toContain('mock failure');
    expect(probe.accountRef).toBeNull();
    // A 401 from the WRONG Scrive is indistinguishable from a bad key, so the failure
    // names the environment it asked — the one fact that separates the two.
    expect(probe.facts).toContainEqual({ label: 'Environment', value: 'testbed (api-testbed.scrive.test)' });
    // And the failure is recorded as health, exactly as a failed dispatch would be.
    const [row] = await host.admin.listConnections(staff, { tenantId: t });
    expect(row!.lastError).not.toBeNull();
  });

  it('projects the dispatch ledger into activity, newest first', async () => {
    const sent = await issue();

    const activity = await scriveConnectionActivity(host, ref(), { fetch: scrive.fetch, baseUrl: BASE });

    expect(activity.live).toBe(false); // no provider read was asked for
    expect(activity.entries).toHaveLength(1);
    const [entry] = activity.entries;
    expect(entry!.key).toBe(`scrive:dispatch:${sent.instance.id}`);
    expect(entry!.reference).toBe([...scrive.documents.values()][0]!.id);
    expect(entry!.status).toBe('sent for signature');
    // Each dispatched party is readable, with what the platform knows about it.
    expect(entry!.facts).toContainEqual({ label: 'Arbetsgivare', value: 'awaiting signature' });
    expect(entry!.facts).toContainEqual({ label: 'Anställd', value: 'awaiting signature' });
  });

  it('never serves the callback capability token', async () => {
    await issue();

    const activity = await scriveConnectionActivity(host, ref(), { fetch: scrive.fetch, baseUrl: BASE });

    // The ledger row holds `webhookToken` — the entire authentication of the callback
    // door. The projection is what keeps it out of a console response, so assert on the
    // serialized answer rather than on a field name.
    const raw = await host.admin.getConnectorState(connId, activity.entries[0]!.key);
    const token = (raw as { webhookToken?: string }).webhookToken;
    expect(token).toBeTruthy();
    expect(JSON.stringify(activity)).not.toContain(token!);
  });

  it('joins the provider’s current state when asked, and says so', async () => {
    await issue();

    const activity = await scriveConnectionActivity(host, ref(), {
      fetch: scrive.fetch,
      baseUrl: BASE,
      live: true,
    });

    expect(activity.live).toBe(true);
    // `pending` at the provider, humanized — not the ledger's 'sent for signature'.
    expect(activity.entries[0]!.status).toBe('awaiting signatures');
    expect(activity.entries[0]!.title).toContain('anstallningsavtal');
  });

  it('degrades to the ledger when the provider cannot be reached', async () => {
    await issue();
    scrive.failWith = 503;

    const activity = await scriveConnectionActivity(host, ref(), {
      fetch: scrive.fetch,
      baseUrl: BASE,
      live: true,
    });

    // A console that cannot reach Scrive should still show what was sent — but it must
    // not present the ledger's view as the provider's, which is what `live` is for.
    expect(activity.live).toBe(false);
    expect(activity.entries).toHaveLength(1);
    expect(activity.entries[0]!.status).toBe('sent for signature');
  });

  it('lists the provider’s own archive, marking what we sent', async () => {
    await issue();
    // A document created outside this platform — the case the ledger structurally cannot
    // show, and the reason `source` is a switch rather than a filter.
    await scrive.fetch(`${BASE}/api/v2/documents/new`, {
      method: 'POST',
      headers: { authorization: 'oauth_signature_method="PLAINTEXT"' },
    });

    const archive = await scriveConnectionActivity(host, ref(), {
      fetch: scrive.fetch,
      baseUrl: BASE,
      source: 'provider',
    });

    expect(archive.source).toBe('provider');
    expect(archive.live).toBe(true); // these ARE the provider's rows
    expect(archive.entries).toHaveLength(2);
    const marks = archive.entries.map((e) => e.facts.find((f) => f.label === 'Sent from')?.value);
    expect(marks).toContain('this app');
    expect(marks).toContain('elsewhere in this Scrive account');
  });

  it('refuses to answer an empty archive when the provider is unreachable', async () => {
    await issue();
    scrive.failWith = 503;

    // No degraded view here, unlike the ledger read: an empty list would read as "the
    // account is empty", which is a lie an operator would act on.
    await expect(
      scriveConnectionActivity(host, ref(), { fetch: scrive.fetch, baseUrl: BASE, source: 'provider' }),
    ).rejects.toThrow();
  });

  it('summarizes the stored credential — identifiers whole, secrets reduced', async () => {
    const summary = await scriveCredentialSummary(host, ref());

    const byKey = Object.fromEntries(summary.fields.map((f) => [f.key, f]));
    // An identifier that cannot be read identifies nothing.
    expect(byKey.clientId).toMatchObject({ value: 'ci', masked: false });
    expect(byKey.tokenId).toMatchObject({ value: 'ti', masked: false });
    // Short secrets are masked ENTIRELY rather than mostly revealed — 'cs' has nothing
    // to hide behind, so no part of it is shown.
    expect(byKey.clientSecret!.masked).toBe(true);
    expect(byKey.clientSecret!.value).toBe('••••••••');
    expect(JSON.stringify(summary)).not.toContain('cs');
  });

  it('shows only the last four of a full-length secret', async () => {
    await host.admin.updateConnectionSecret(staff, connId, {
      clientId: 'client-id-1234',
      clientSecret: 'sk-live-abcdefgh9876',
      tokenId: 'token-id-5678',
      tokenSecret: 'tk-live-ijklmnop5432',
    });

    const summary = await scriveCredentialSummary(host, ref());
    const byKey = Object.fromEntries(summary.fields.map((f) => [f.key, f]));

    expect(byKey.clientSecret!.value).toBe('••••••••9876');
    expect(byKey.tokenSecret!.value).toBe('••••••••5432');
    // Enough to recognise a credential, never enough to sign with one.
    expect(JSON.stringify(summary)).not.toContain('abcdefgh');
    expect(JSON.stringify(summary)).not.toContain('ijklmnop');
  });

  it('orders several dispatches newest first', async () => {
    const first = await issue('01JEMPLOYEE0000000000000AA');
    const second = await issue('01JEMPLOYEE0000000000000BB');

    const activity = await scriveConnectionActivity(host, ref(), { fetch: scrive.fetch, baseUrl: BASE });

    expect(activity.entries).toHaveLength(2);
    const keys = activity.entries.map((e) => e.key);
    expect(keys[0]).toBe(`scrive:dispatch:${second.instance.id}`);
    expect(keys[1]).toBe(`scrive:dispatch:${first.instance.id}`);
  });
  // -- the connect-time gate (#605): probing a credential that is not stored yet ---

  const CANDIDATE = { clientId: 'ci', clientSecret: 'cs', tokenId: 'ti', tokenSecret: 'ts' };

  it('probes a candidate credential without touching the store', async () => {
    const probe = await probeScriveSecret(CANDIDATE, { fetch: scrive.fetch, baseUrl: BASE });

    expect(probe.ok).toBe(true);
    expect(probe.accountRef).toBe('30338661');
    // No connection was opened, so no health was written against the live one — a
    // candidate's outcome is not a fact about the connection that already exists.
    const [row] = await host.admin.listConnections(staff, { tenantId: t });
    expect(row!.lastOkAt).toBeNull();
  });

  it('marks a provider REJECTION as refused — the answer a connect may act on', async () => {
    scrive.failWith = 401;

    const probe = await probeScriveSecret(CANDIDATE, { fetch: scrive.fetch, baseUrl: BASE });

    expect(probe.ok).toBe(false);
    expect(probe.refused).toBe(true); // 401 — the provider spoke about the credential
  });

  it('does NOT mark a provider OUTAGE as refused', async () => {
    scrive.failWith = 503;

    const probe = await probeScriveSecret(CANDIDATE, { fetch: scrive.fetch, baseUrl: BASE });

    expect(probe.ok).toBe(false);
    // A 503 says nothing about the credential. Calling this "refused" would block a
    // legitimate connect during a Scrive outage — and block the rotation someone is
    // attempting precisely because things are broken.
    expect(probe.refused).toBe(false);
  });

  it('refuses an incomplete credential without spending a call', async () => {
    scrive.failWith = 500; // would make any real call fail — none should happen

    const probe = await probeScriveSecret({ clientId: 'ci' }, { fetch: scrive.fetch, baseUrl: BASE });

    expect(probe).toMatchObject({ ok: false, refused: true });
    expect(probe.error).toContain('clientSecret');
  });
});
