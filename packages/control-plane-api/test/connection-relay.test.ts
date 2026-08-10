import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { relayConnectionUpsert, ConnectionRelayError } from '../src/index.js';

/**
 * The connection relay (connections.md §3.5.2) — a tenant admin hands a provider
 * credential over from the vertical's own UI, and the platform seals it into the
 * connection store. The properties under test are the relay's, not the store's
 * (the store is contract-tested): the vertical is re-derived from the directory
 * rather than trusted from the caller, upsert rotates in place so grants survive,
 * attribution names the tenant principal on both paths, and the plaintext never
 * reaches the audit log.
 */
describe('relayConnectionUpsert — /internal/connections/upsert logic', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const relayActor = platformActorId.parse(ulid());
  const staff = platformActorId.parse(ulid());
  const t1 = tenantId.parse(ulid());
  const s1 = scopeId.parse(ulid());
  const bare = scopeId.parse(ulid()); // provisioned with no vertical
  const t2 = tenantId.parse(ulid());
  const s2 = scopeId.parse(ulid());
  const admin = principalId.parse(ulid()); // the office-admin whose act this is

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-conn-relay-'));
    host = new SqliteScopeHost({
      dir,
      secretBox: webCryptoSecretBox('k1', new Uint8Array(32).fill(7)),
    });
    await host.admin.createTenant(staff, { id: t1, slug: 'egeryds', name: 'Egeryds' });
    await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'egeryds-crm' });
    await host.provisionScope(staff, { tenantId: t1, scopeId: bare });
    await host.admin.createTenant(staff, { id: t2, slug: 'other', name: 'Other' });
    await host.provisionScope(staff, { tenantId: t2, scopeId: s2, vertical: 'other-vert' });
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const request = (over: Record<string, unknown> = {}) => ({
    tenantId: t1,
    scopeId: s1,
    provider: 'scrive',
    label: 'Egeryds Scrive (prod)',
    secret: { apiToken: 'oauth1-token-SECRET', apiSecret: 'oauth1-secret-SECRET' },
    grants: ['protocol:record-signature'],
    createdBy: admin,
    ...over,
  });

  it('creates on first call: vertical from the directory, principal attribution, grant applied', async () => {
    const result = await relayConnectionUpsert(host, relayActor, request());
    expect(result.created).toBe(true);
    expect(result.granted).toEqual(['protocol:record-signature']);

    const [conn] = await host.admin.listConnections(staff, { tenantId: t1, provider: 'scrive' });
    expect(conn).toMatchObject({
      id: result.connectionId,
      // Re-derived from the scope record — the request never named it.
      vertical: 'egeryds-crm',
      label: 'Egeryds Scrive (prod)',
      status: 'active',
      // §3.5.1 — the tenant admin who authorized the connect, never the platform actor.
      createdBy: admin,
    });

    const log = await host.admin.auditLog(staff, { tenantId: t1 });
    const grant = log.find((e) => e.action === 'grantToConnection');
    expect(grant?.after).toMatchObject({
      connectionId: result.connectionId,
      permission: 'protocol:record-signature',
    });
  });

  it('rotates in place on the second call: same id, rotatedBy in the audit, grants intact', async () => {
    const [before] = await host.admin.listConnections(staff, { tenantId: t1, provider: 'scrive' });
    const result = await relayConnectionUpsert(
      host,
      relayActor,
      request({ secret: { apiToken: 'rotated-token-SECRET', apiSecret: 'rotated-secret-SECRET' } }),
    );
    expect(result.created).toBe(false);
    expect(result.connectionId).toBe(before!.id);

    // Still exactly one live connection — rotation is never revoke + create.
    const after = await host.admin.listConnections(staff, { tenantId: t1, provider: 'scrive' });
    expect(after).toHaveLength(1);

    const log = await host.admin.auditLog(staff, { tenantId: t1 });
    const rotated = log.find((e) => e.action === 'updateConnectionSecret');
    expect(rotated?.after).toMatchObject({ id: before!.id, rotatedBy: admin });
  });

  it('never lets the credential reach the audit log, on either path', async () => {
    const log = await host.admin.auditLog(staff, { tenantId: t1 });
    expect(JSON.stringify(log)).not.toContain('SECRET');
  });

  it('a distinct external account is a new connection, not a rotation', async () => {
    const result = await relayConnectionUpsert(
      host,
      relayActor,
      request({ externalAccountRef: 'scrive-company-2', label: 'Second company' }),
    );
    expect(result.created).toBe(true);
    const all = await host.admin.listConnections(staff, { tenantId: t1, provider: 'scrive' });
    expect(all).toHaveLength(2);
  });

  it('refuses a scope with no vertical bound (404)', async () => {
    await expect(
      relayConnectionUpsert(host, relayActor, request({ scopeId: bare })),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("cannot plant a credential across tenants: another tenant's scope reads as absent (K-3)", async () => {
    await expect(
      relayConnectionUpsert(host, relayActor, request({ scopeId: s2 })),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a malformed body with a named field (400), before touching the host', async () => {
    await expect(
      relayConnectionUpsert(host, relayActor, request({ secret: {} })),
    ).rejects.toThrow(ConnectionRelayError);
    await expect(relayConnectionUpsert(host, relayActor, request({ secret: {} }))).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      relayConnectionUpsert(host, relayActor, request({ createdBy: undefined })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('every grant the relay applied is pinned to the calling tenant and its vertical', async () => {
    // The store's own guards (tenant match, scope-vertical match) are contract-tested;
    // here we prove the relay only ever fed them the calling scope's node, by reading
    // what actually landed in the audit.
    const log = await host.admin.auditLog(staff, { tenantId: t1 });
    const grants = log.filter((e) => e.action === 'grantToConnection');
    expect(grants.length).toBeGreaterThan(0);
    for (const g of grants) {
      expect(g.tenantId).toBe(t1);
      expect(g.vertical).toBe('egeryds-crm');
    }
  });
});
