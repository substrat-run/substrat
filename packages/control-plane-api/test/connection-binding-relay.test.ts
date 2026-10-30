import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid, webCryptoSecretBox, type ConnectionBinder } from '@substrat-run/kernel';
import { connectionId, permissionKey, platformActorId, principalId, scopeId, tenantId, type ConnectionId, type ScopeId } from '@substrat-run/contracts';
import { bindPlanimaScope, listPlanimaBindings, unbindPlanimaScope } from '@substrat-run/connector-planima';
import {
  ConnectionRelayError,
  connectionBindingOptions,
  relayConnectionBind,
  relayConnectionUnbind,
  relayConnectionUpsert,
  type ConnectionBindingRelayOptions,
} from '../src/index.js';
import { heldVersion } from './held-manifest.js';

/**
 * #2732: a vertical whose spaces each connect one folder of a file source. Each space (a scope)
 * makes its own connection through the upsert relay, binds it to itself with its own options
 * through the on-request landing its running version declares, and unbinds it again. Two scopes of
 * one vertical in one tenant; Planima's own binder stands in for the file source's, built the way
 * the control plane's `connectionBindersFor` builds it.
 */
describe('a scope binds its own connection through the relay (#2732)', () => {
  const SLUG = 'acme-drive';
  const LAND = permissionKey.parse('plan:record');
  const relayActor = platformActorId.parse(ulid());
  const person = principalId.parse(ulid());

  let dir: string;
  let host: SqliteScopeHost;
  let t: ReturnType<typeof tenantId.parse>;
  let a: ScopeId;
  let b: ScopeId;

  const binder: ConnectionBinder = {
    list: (h, row) => listPlanimaBindings(h, row.id),
    bind: (h, row, target) => bindPlanimaScope(h, { ...(target as Parameters<typeof bindPlanimaScope>[1]), connectionId: row.id }),
    bindBeforeGrant: (h, row, target) => bindPlanimaScope(h, { ...(target as Parameters<typeof bindPlanimaScope>[1]), connectionId: row.id, grantPreflighted: true }),
    options: (raw, current) => {
      const schema = connectionBindingOptions('planima');
      return schema.parse({ ...(current ? schema.strip().parse(current) : {}), ...(raw ?? {}) });
    },
    unbind: (h, row, s) => unbindPlanimaScope(h, row.id, s),
  };
  const landings = (proven = true): ConnectionBindingRelayOptions => ({
    proven,
    landings: { read: (slug, versionId) => host.versionConnectionLandings(slug, versionId), binders: { planima: binder } },
  });

  /** A version of the vertical declaring the landing in `mode`, and every scope given it. */
  const runs = async (mode: 'on-request' | 'every-install') => {
    const id = ulid();
    await host.admin.publishVersion(relayActor, await heldVersion({
      id, verticalSlug: SLUG, version: `1.0.${id.toLowerCase()}`, manifestDigest: `m-${id}`, permissionDigest: 'p', migrationDigest: 'g', deploymentRef: null,
      manifestJson: JSON.stringify({
        registry: {
          permissions: [{ key: LAND, description: 'land a plan', declaredBy: ['@acme/drive'] }],
          roles: [],
          entityGrants: [],
          connections: [{ provider: 'planima', operation: 'drive/land', permission: LAND, ...(mode === 'on-request' ? { bind: mode } : {}), declaredBy: ['@acme/drive'] }],
        },
      }),
    }));
    await host.admin.admitVersion(relayActor, id);
    for (const s of [a, b]) await host.admin.bindScopeVersion(relayActor, t, s, id);
  };

  /** A scope's own connection, as the upsert relay makes one. */
  const own = async (s: ScopeId): Promise<ConnectionId> => {
    const id = connectionId.parse(ulid());
    await host.admin.createConnection(relayActor, { id, tenantId: t, vertical: SLUG, provider: 'planima', label: 'own', secret: { token: `tok-${s}` }, ownerScopeId: s });
    return id;
  };
  const bindBody = (s: ScopeId, conn: ConnectionId, options: Record<string, unknown> = { horizonYears: 10 }) => ({ tenantId: t, scopeId: s, connectionId: conn, options, boundBy: person });
  const holds = async (s: ScopeId, conn: ConnectionId) => (await host.connectionGrantsInScope(t, s)).some((g) => g.connectionId === conn && g.permission === LAND);
  const refusal = (p: Promise<unknown>) => p.then(() => 200, (e: unknown) => (e instanceof ConnectionRelayError ? e.status : e));

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'connection-binding-relay-'));
    host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('k', new Uint8Array(32).fill(7)) });
    t = tenantId.parse(ulid());
    a = scopeId.parse(ulid());
    b = scopeId.parse(ulid());
    await host.admin.createTenant(relayActor, { id: t, slug: 'acme', name: 'Acme' });
    await host.admin.registerVertical(relayActor, { slug: SLUG, name: 'Acme Drive', source: 'builtin' });
    for (const s of [a, b]) {
      await host.provisionScope(relayActor, { tenantId: t, scopeId: s, vertical: SLUG });
      await host.admin.activateScope(relayActor, t, s);
    }
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("binds a scope's own connection to that scope alone, with its options, and audits who asked", async () => {
    await runs('on-request');
    const conn = await own(a);

    const bound = await relayConnectionBind(host, relayActor, bindBody(a, conn), landings());

    expect(bound).toMatchObject({ connectionId: conn, scopeId: a, options: expect.objectContaining({ horizonYears: 10 }) });
    expect(await holds(a, conn)).toBe(true);
    expect(await holds(b, conn)).toBe(false);
    expect((await listPlanimaBindings(host, conn)).map((x) => [x.scopeId, x.operation, x.permission])).toEqual([[a, 'drive/land', LAND]]);
    const row = (await host.admin.auditLog(relayActor, { tenantId: t })).find((e) => e.action === 'bindConnectionScope');
    expect(row?.after).toMatchObject({ connectionId: conn, requestedBy: person, phase: 'applied' });
  });

  it("refuses an unproven caller, another scope's or the tenant's connection, a landing that is not on request, and options the connector refuses", async () => {
    await runs('on-request');
    const ofA = await own(a);
    const tenants = connectionId.parse(ulid());
    await host.admin.createConnection(relayActor, { id: tenants, tenantId: t, vertical: SLUG, provider: 'planima', label: 'tenant', secret: { token: 'tok' } });

    expect(await refusal(relayConnectionBind(host, relayActor, bindBody(a, ofA), landings(false)))).toBe(403);
    expect(await refusal(relayConnectionBind(host, relayActor, bindBody(b, ofA), landings()))).toBe(404);
    expect(await refusal(relayConnectionBind(host, relayActor, bindBody(a, tenants), landings()))).toBe(404);
    expect(await refusal(relayConnectionBind(host, relayActor, bindBody(a, ofA, { horizonYears: 'fifty' }), landings()))).toBe(422);
    await runs('every-install');
    expect(await refusal(relayConnectionBind(host, relayActor, bindBody(a, ofA), landings()))).toBe(409);
    // Nothing above granted or bound anything.
    expect(await holds(a, ofA)).toBe(false);
    expect(await listPlanimaBindings(host, ofA)).toEqual([]);
  });

  it('unbinds: the binding and the key go, a second unbind is the same answer, and who asked is on the revoke', async () => {
    await runs('on-request');
    const conn = await own(a);
    await relayConnectionBind(host, relayActor, bindBody(a, conn), landings());
    const unbind = () => relayConnectionUnbind(host, relayActor, { tenantId: t, scopeId: a, connectionId: conn, unboundBy: person }, landings());

    expect(await unbind()).toEqual({ connectionId: conn, scopeId: a, unbound: true });
    expect(await unbind()).toEqual({ connectionId: conn, scopeId: a, unbound: true });
    expect(await holds(a, conn)).toBe(false);
    expect(await listPlanimaBindings(host, conn)).toEqual([]);
    // The connection itself stays the scope's, and binding again resumes.
    await relayConnectionBind(host, relayActor, bindBody(a, conn), landings());
    expect(await holds(a, conn)).toBe(true);
    const revokes = (await host.admin.auditLog(relayActor, { tenantId: t })).filter((e) => e.action === 'revokeFromConnection');
    expect(revokes.map((e) => e.before)).toEqual([expect.objectContaining({ connectionId: conn, revokedBy: person })]);
  });

  it("makes each scope's own connection on one account through the upsert, refused where it cannot be the scope's", async () => {
    await runs('on-request');
    const upsert = (s: ScopeId, token: string, held: { proven?: boolean; ownable?: boolean } = {}) =>
      relayConnectionUpsert(host, relayActor, { tenantId: t, scopeId: s, provider: 'planima', secret: { token }, createdBy: person, owner: 'scope' }, {
        scopeOwned: {
          proven: held.proven ?? true,
          scopeOwnable: () => held.ownable ?? true,
          readLandings: (slug, versionId) => host.versionConnectionLandings(slug, versionId),
        },
      });

    const ofA = await upsert(a, 'a');
    const ofB = await upsert(b, 'b');
    const rotatedA = await upsert(a, 'a2');
    expect([ofA.created, ofB.created, rotatedA.created]).toEqual([true, true, false]);
    expect(rotatedA.connectionId).toBe(ofA.connectionId);
    expect(ofB.connectionId).not.toBe(ofA.connectionId);
    expect((await host.admin.openConnection(t, SLUG, 'planima', undefined, a))?.secret).toEqual({ token: 'a2' });

    expect(await refusal(upsert(a, 'x', { proven: false }))).toBe(403);
    expect(await refusal(upsert(a, 'x', { ownable: false }))).toBe(409);
    await runs('every-install');
    expect(await refusal(upsert(a, 'x'))).toBe(409);
  });
});
