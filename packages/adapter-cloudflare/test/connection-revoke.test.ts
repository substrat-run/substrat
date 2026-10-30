import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { connectionId as connectionIdOf, permissionKey, platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ConnectorRevokeUnsupported, ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { CloudflareScopeHost, type ConnectorDelegation } from './test-host.js';
import { warmControlPlane } from './do-warmup.js';

/**
 * #2732: `revokeFromConnection` on the hosted adapter, where the tuple and the record live apart.
 *
 * - On a plane that does not serve the scope, the tuple goes through `ConnectorDelegation.revoke`,
 *   and a deployment that cannot take it leaves everything as it was.
 * - In the deployment that serves the scope, the revoke is a tombstone, and a reconcile's seat
 *   afterwards does not deliver the key again.
 */
describe('revokeFromConnection on the hosted adapter (#2732)', () => {
  beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

  const staff = platformActorId.parse(ulid());
  const LAND = permissionKey.parse('perm:land');
  const USE = permissionKey.parse('perm:use');
  const box = () => webCryptoSecretBox('test-key', new Uint8Array(32).fill(7));

  /** One tenant, scope and connection holding LAND on the scope, through `host`. */
  const world = async (host: CloudflareScopeHost) => {
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const conn = connectionIdOf.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'docs' });
    await host.admin.activateScope(staff, t, s);
    await host.admin.createConnection(staff, { id: conn, tenantId: t, vertical: 'docs', provider: 'signer', label: 'signer', secret: { accessToken: 'x' } });
    await host.admin.grantToConnection(staff, { connectionId: conn, permission: LAND, node: { tenantId: t, scopeId: s }, grantedBy: staff });
    const revoke = () => host.admin.revokeFromConnection(staff, { connectionId: conn, permission: LAND, node: { tenantId: t, scopeId: s } });
    const audited = async () => (await host.admin.auditLog(staff, { tenantId: t })).filter((e) => e.action === 'revokeFromConnection').length;
    const recorded = async () => (await host.admin.listConnectionGrants(staff, t)).map((g) => g.permission);
    return { t, s, conn, revoke, audited, recorded };
  };

  it('through the delegation: refused, with nothing moved, where the deployment cannot take it; revoked and audited once where it can', async () => {
    const delivered: unknown[] = [];
    let live = true;
    const delegation = (revoke?: ConnectorDelegation['revoke']): ConnectorDelegation => ({
      invoke: async () => ({}),
      uploadAttachment: async () => ({}) as never,
      openAttachment: async () => null,
      grant: async () => {},
      ...(revoke ? { revoke } : {}),
    });
    const hostWith = (d: ConnectorDelegation) =>
      new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE, secretBox: box(), connectorDelegation: d });
    const w = await world(hostWith(delegation()));

    await expect(w.revoke()).rejects.toBeInstanceOf(ConnectorRevokeUnsupported);
    expect(await w.recorded()).toEqual([LAND]);
    expect(await w.audited()).toBe(0);

    const able = await world(hostWith(delegation(async (a) => {
      delivered.push(a);
      const was = live;
      live = false;
      return was;
    })));
    await able.revoke();
    await able.revoke();
    expect(delivered).toEqual([
      { connectionId: able.conn, tenantId: able.t, scopeId: able.s, vertical: 'docs', permission: LAND },
      { connectionId: able.conn, tenantId: able.t, scopeId: able.s, vertical: 'docs', permission: LAND },
    ]);
    expect(await able.recorded()).toEqual([]);
    expect(await able.audited()).toBe(1);
  });

  it("the serving deployment's end: revoked once, then a no-op, and a reconcile's seat never delivers it again", async () => {
    // The vertical's own (CP-less) host, which is where a reconcile seats: `seatScopeLocal`.
    const host = new CloudflareScopeHost({ scope: env.SCOPE, secretBox: box() });
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const conn = connectionIdOf.parse(ulid());
    const grant = { connectionId: conn, permission: USE };
    /** Whether the scope's own store holds the grant live, read where it is checked. */
    const held = async () =>
      (await host.introspectScopeQuery(s, {
        sql: `SELECT 1 FROM _substrat_tuples WHERE subject = 'connection:${conn}' AND relation = 'granted:${USE}' AND revoked_at IS NULL`,
      })).rows.length === 1;
    await host.provisionScopeLocal({
      tenantId: t, scopeId: s, owner: principalId.parse(ulid()),
      roles: [{ key: 'office-admin', permissions: [USE], source: 'vertical' }], ownerRoleKey: 'office-admin',
      connectionGrants: [grant],
    });
    expect(await held()).toBe(true);

    expect(await host.connectorRevokeLocal(conn, s, USE)).toBe(true);
    expect(await host.connectorRevokeLocal(conn, s, USE)).toBe(false);
    // The directory's gather no longer carries it; a seat handed it anyway (a stale gather) still
    // does not un-revoke the tombstone (#1659).
    await host.seatScopeLocal({ tenantId: t, scopeId: s, connectionGrants: [] });
    await host.seatScopeLocal({ tenantId: t, scopeId: s, connectionGrants: [grant] });
    expect(await held()).toBe(false);
  });
});
