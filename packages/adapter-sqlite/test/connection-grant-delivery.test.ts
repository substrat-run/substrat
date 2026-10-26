/**
 * #2526: `grantToConnection` at a scope node. The directory record and the admin row commit as one
 * directory unit, and the tuple is written in the scope's own store after it. When that write is
 * refused, the call throws, and the record and its row stand without a tuple. This host re-seats
 * nothing from the record (no provision or reconcile reads it), so a re-grant is what delivers it.
 *
 * ADAPTER-SPECIFIC: the hosted adapter's half-state is the same, but its reconcile re-seats the
 * tuple from the record (`adapter-cloudflare/test/contract-hosts.test.ts`).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { connectionId, permissionKey, platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid, UNSAFE_allowAllChecker, webCryptoSecretBox } from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

const VERTICAL = 'delivery-vertical';
const USE = permissionKey.parse('delivery:use');

describe('grantToConnection at a scope node, when the scope refuses the tuple (#2526)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-connection-delivery-'));
  const host = new SqliteScopeHost({
    dir,
    checker: UNSAFE_allowAllChecker,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  const staff = platformActorId.parse(ulid());
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws, and leaves the record and its row with no tuple; a re-grant delivers it', async () => {
    const t = tenantId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `delivery-${ulid().toLowerCase()}`, name: 'Delivery' });
    const s = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: VERTICAL });
    const conn = connectionId.parse(ulid());
    await host.admin.createConnection(staff, {
      id: conn, tenantId: t, vertical: VERTICAL, provider: `delivery-${conn.toLowerCase()}`, label: 'Delivery', secret: { accessToken: 'tok' },
    });
    const scopeDb = (host as unknown as { runtime(t: string, s: string): { db: { exec(sql: string): void } } }).runtime(t, s).db;
    const grant = () => host.admin.grantToConnection(staff, { connectionId: conn, permission: USE, node: { tenantId: t, scopeId: s }, grantedBy: staff });
    const recorded = async () => (await host.admin.listConnectionGrants(staff, t)).filter((g) => g.connectionId === conn).length;
    const rows = async () => (await host.admin.auditLog(staff, { tenantId: t, action: ['grantToConnection'] })).length;
    const delivered = async () => (await host.connectionGrantsInScope(t, s)).filter((g) => g.connectionId === conn).length;

    scopeDb.exec(`CREATE TRIGGER test_refuse_delivery BEFORE INSERT ON _substrat_tuples
      BEGIN SELECT RAISE(ABORT, 'refused by test_refuse_delivery (test fault)'); END`);
    await expect(grant()).rejects.toThrow(/test fault/);
    expect([await recorded(), await rows(), await delivered()]).toEqual([1, 1, 0]);

    scopeDb.exec('DROP TRIGGER test_refuse_delivery');
    await grant();
    expect([await recorded(), await rows(), await delivered()]).toEqual([1, 2, 1]);
  });
});
