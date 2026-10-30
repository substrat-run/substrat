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
  const INGEST = permissionKey.parse('plan:ingest');
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
  const landings = (proven = true, with_: ConnectionBinder = binder): ConnectionBindingRelayOptions => ({
    proven,
    landings: { read: (slug, versionId) => host.versionConnectionLandings(slug, versionId), binders: { planima: with_ } },
  });

  /** A version of the vertical declaring the landing in `mode`, holding `key`, and every scope given it. */
  const runs = async (mode: 'on-request' | 'every-install', key = LAND) => {
    const id = ulid();
    await host.admin.publishVersion(relayActor, await heldVersion({
      id, verticalSlug: SLUG, version: `1.0.${id.toLowerCase()}`, manifestDigest: `m-${id}`, permissionDigest: 'p', migrationDigest: 'g', deploymentRef: null,
      manifestJson: JSON.stringify({
        registry: {
          permissions: [LAND, INGEST].map((k) => ({ key: k, description: 'land a plan', declaredBy: ['@acme/drive'] })),
          roles: [],
          entityGrants: [],
          connections: [{ provider: 'planima', operation: 'drive/land', permission: key, ...(mode === 'on-request' ? { bind: mode } : {}), declaredBy: ['@acme/drive'] }],
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

  it("takes back the key it granted when the connector's own bind refuses, as a vertical-defined connector does", async () => {
    await runs('on-request');
    const conn = await own(a);
    // The vertical-defined binder's shape: no staged bind, options merged, validated inside `bind`.
    const refusing: ConnectionBinder = {
      list: binder.list,
      options: (raw, current) => ({ ...current, ...raw }),
      bind: async () => {
        throw new Error('no such folder');
      },
      unbind: binder.unbind!,
    };

    expect(await refusal(relayConnectionBind(host, relayActor, bindBody(a, conn), landings(true, refusing)))).toBe(422);
    expect(await holds(a, conn)).toBe(false);
  });

  it('keeps the standing grants the connection was made with across an unbind and a rebind', async () => {
    await runs('on-request');
    const { connectionId: conn } = await relayConnectionUpsert(
      host,
      relayActor,
      { tenantId: t, scopeId: a, provider: 'planima', secret: { token: 'a' }, grants: [INGEST], createdBy: person, owner: 'scope' },
      { scopeOwned: { proven: true, scopeOwnable: () => true, readLandings: (slug, versionId) => host.versionConnectionLandings(slug, versionId) } },
    );
    const keys = async () => (await host.connectionGrantsInScope(t, a)).filter((g) => g.connectionId === conn).map((g) => g.permission).sort();
    const id = connectionId.parse(conn);

    await relayConnectionBind(host, relayActor, bindBody(a, id), landings());
    await relayConnectionUnbind(host, relayActor, { tenantId: t, scopeId: a, connectionId: id, unboundBy: person }, landings());
    expect(await keys()).toEqual([INGEST]);
    await relayConnectionBind(host, relayActor, bindBody(a, id), landings());
    expect(await keys()).toEqual([INGEST, LAND].sort());
  });

  it('a refused bind takes back a key a refused bind before it left, once taking it back works again, fresh or on a rebind', async () => {
    await runs('on-request');
    // The vertical-defined binder's shape: no staged bind, options merged, validated inside `bind`.
    const refusing: ConnectionBinder = {
      list: binder.list,
      options: (raw, current) => ({ ...current, ...raw }),
      bind: async () => {
        throw new Error('no such folder');
      },
      unbind: binder.unbind!,
    };
    // The host as the relay sees it, with its `failAt`-th revoke failing.
    let revokes = 0;
    let failAt = 1;
    const flaky = new Proxy(host, {
      get(target, prop) {
        if (prop === 'admin') {
          return new Proxy(target.admin, {
            get(admin, key) {
              const v = Reflect.get(admin, key);
              if (key === 'revokeFromConnection') {
                return async (...args: Parameters<typeof target.admin.revokeFromConnection>) => {
                  revokes += 1;
                  if (revokes === failAt) throw new Error('the scope did not answer');
                  return target.admin.revokeFromConnection(...args);
                };
              }
              return typeof v === 'function' ? v.bind(admin) : v;
            },
          });
        }
        const v = Reflect.get(target, prop);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const holdsKey = async (conn: ConnectionId, key: string) =>
      (await host.connectionGrantsInScope(t, a)).some((g) => g.connectionId === conn && g.permission === key);
    const bindRefused = (conn: ConnectionId) => relayConnectionBind(flaky, relayActor, bindBody(a, conn), landings(true, refusing));

    // A fresh bind: its cleanup revoke (the first) fails, and the retry clears the key.
    const fresh = await own(a);
    expect(await bindRefused(fresh).catch((e: unknown) => e)).toMatchObject({ status: 503, message: expect.stringContaining('no such folder') });
    expect(await holdsKey(fresh, LAND)).toBe(true);
    expect(await refusal(bindRefused(fresh))).toBe(422);
    expect(await holdsKey(fresh, LAND)).toBe(false);

    // A rebind under a changed key: bound under LAND, then the version lands with INGEST. The old key
    // goes first; the cleanup revoke of the new one (the second revoke) fails; the retry clears it,
    // although the scope's binding still records the old key.
    await relayConnectionBind(host, relayActor, bindBody(a, fresh), landings());
    await runs('on-request', INGEST);
    revokes = 0;
    failAt = 2;
    expect(await bindRefused(fresh).catch((e: unknown) => e)).toMatchObject({ status: 503, message: expect.stringContaining('no such folder') });
    expect(await holdsKey(fresh, INGEST)).toBe(true);
    expect(await refusal(bindRefused(fresh))).toBe(422);
    expect([await holdsKey(fresh, INGEST), await holdsKey(fresh, LAND)]).toEqual([false, false]);
  });

  it("takes the previous key back on a rebind under a landing whose key changed, so an unbind then leaves nothing", async () => {
    await runs('on-request');
    const conn = await own(a);
    await relayConnectionBind(host, relayActor, bindBody(a, conn), landings());
    await runs('on-request', INGEST);

    await relayConnectionBind(host, relayActor, bindBody(a, conn), landings());

    const keys = async () => (await host.connectionGrantsInScope(t, a)).filter((g) => g.connectionId === conn).map((g) => g.permission);
    expect(await keys()).toEqual([INGEST]);
    expect((await listPlanimaBindings(host, conn)).map((x) => x.permission)).toEqual([INGEST]);
    await relayConnectionUnbind(host, relayActor, { tenantId: t, scopeId: a, connectionId: conn, unboundBy: person }, landings());
    expect(await keys()).toEqual([]);
  });

  it('unbinds what the scope holds after its version changed the landing, its key and its mode', async () => {
    await runs('on-request');
    const conn = await own(a);
    await relayConnectionBind(host, relayActor, bindBody(a, conn), landings());
    await runs('every-install', INGEST);

    await relayConnectionUnbind(host, relayActor, { tenantId: t, scopeId: a, connectionId: conn, unboundBy: person }, landings());

    expect(await holds(a, conn)).toBe(false);
    expect(await listPlanimaBindings(host, conn)).toEqual([]);
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
