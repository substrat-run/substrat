import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { ulid } from '@substrat-run/kernel';
import type { PeerCaller } from '@substrat-run/contracts';
import { createPeerCallResolver, type PeerCallDecision, type PeerCallTargetRowLike } from '../src/route-resolver.js';
import { peerCallKvKey, readModelPeerCallReader, RouteMemoryCache, type PeerCallKey } from '../src/route-read-model.js';
import { RouteReadModelPublisher, type RouteKvWriter } from '../src/route-read-model-publisher.js';
import { warmDurableObject } from './do-warmup.js';

/**
 * #3395 follow-up: peer-call answers on the routing read model. The oracle is the directory's own
 * decision: whatever a change did, a published answer decides exactly what the directory decides,
 * and an answer the directory would refuse is not in KV at all (the router then asks the directory).
 */

interface Directory {
  peerCallTarget(t: string, s: string, cv: string, v: string, opts?: { publish?: boolean }): PeerCallTargetRowLike;
  settleRouteReadModel(): Promise<void>;
}

const AT = '2026-11-26T00:00:00.000Z';
const ns = () => env.ROUTES_CONTROL_PLANE;
const stub = () => ns().get(ns().idFromName('control-plane'));

/** The router's gates over a given answer: the decision a row makes, with no directory behind it. */
const decide = (caller: PeerCaller, target: string, row: PeerCallTargetRowLike): Promise<PeerCallDecision> =>
  createPeerCallResolver({ idFromName: () => 'id', get: () => ({ peerCallTarget: async () => row }) } as unknown as DurableObjectNamespace)(
    caller,
    target,
  );

interface World {
  tenant: string;
  caller: string;
  target: string;
  /** The caller's and the target's vertical slugs. */
  from: string;
  to: string;
  key: PeerCallKey;
  peer: PeerCaller;
}

/** A tenant, the caller's vertical and the target's (two versions, serving the first), one scope each. */
function seed(sql: SqlStorage, opts: { jurisdiction?: string | null } = {}): World {
  const id = ulid().toLowerCase();
  const from = `from-${id}`;
  const to = `to-${id}`;
  const w = { tenant: ulid(), caller: ulid(), target: ulid(), from, to };
  sql.exec(`INSERT INTO tenants (tenant_id, slug, name, created_at) VALUES (?, ?, 'T', ?)`, w.tenant, `t-${id}`, AT);
  const version = (slug: string, n: string, host: string) =>
    sql.exec(
      `INSERT INTO vertical_versions (id, vertical_slug, version, manifest_digest, permission_digest, migration_digest,
         admission, created_at, deployment_ref, manifest_json)
       VALUES (?, ?, ?, 'm', 'p', 'g', 'admitted', ?, ?, ?)`,
      `${slug}-v${n}`, slug, `1.0.${n}`, AT, `${slug}-v${n}`, JSON.stringify({ outbound: [host], calls: [] }),
    );
  for (const slug of [from, to]) {
    version(slug, '1', 'one.example');
    version(slug, '2', 'two.example');
    sql.exec(
      `INSERT INTO verticals (slug, name, source, created_at, serving_ref, serving_version_id) VALUES (?, ?, 'cli', ?, ?, ?)`,
      slug, slug, AT, `${slug}-serving`, `${slug}-v1`,
    );
  }
  const scope = (scopeId: string, slug: string, jurisdiction: string | null) =>
    sql.exec(
      `INSERT INTO scopes (scope_id, tenant_id, slug, kind, name, vertical, vertical_version_id, serving_ref, jurisdiction, created_at)
       VALUES (?, ?, ?, 'install', 'S', ?, ?, ?, ?, ?)`,
      scopeId, w.tenant, `s-${scopeId.toLowerCase()}`, slug, `${slug}-v1`, `${slug}-serving`, jurisdiction, AT,
    );
  scope(w.caller, from, null);
  scope(w.target, to, opts.jurisdiction ?? null);
  return {
    ...w,
    key: { tenantId: w.tenant, callerScopeId: w.caller, callerVertical: from, vertical: to },
    peer: { vertical: from, tenantId: w.tenant, scopeId: w.caller, calls: [to], depth: 0 } as PeerCaller,
  };
}

/** What the read model decides with a cold memory, or `'miss'` when only the directory can answer. */
async function fromModel(w: World): Promise<PeerCallDecision | 'miss'> {
  const row = await readModelPeerCallReader({ kv: env.TEST_ROUTES, cache: new RouteMemoryCache() })(w.key);
  return row === 'miss' ? 'miss' : decide(w.peer, w.to, row);
}

describe('#3395 follow-up: peer-call answers on the routing read model', () => {
  beforeAll(async () => {
    await warmDurableObject(async () => (stub() as unknown as Directory).settleRouteReadModel());
  });

  it('every kind of change moves a published answer to what the directory decides, and a refusal out of KV', async () => {
    await runInDurableObject(stub(), async (instance, state) => {
      const dir = instance as unknown as Directory;
      const sql = state.storage.sql;
      const w = seed(sql);
      const ask = () => dir.peerCallTarget(w.tenant, w.caller, w.from, w.to, { publish: true });
      const second = ulid();
      const steps: Array<{ name: string; change: () => void; expect: (d: PeerCallDecision) => void }> = [
        {
          name: 'the router asked once: a serving target, its vertical’s policy',
          change: () => ask(),
          expect: (d) => expect(d).toMatchObject({ outcome: 'dispatch', scopeId: w.target, deploymentRef: `${w.to}-serving`, outboundHosts: ['one.example'] }),
        },
        {
          name: 'promote: the serving policy moves, and no peer entry is rewritten for it',
          change: () => sql.exec(`UPDATE verticals SET serving_version_id = ? WHERE slug = ?`, `${w.to}-v2`, w.to),
          expect: (d) => expect(d).toMatchObject({ outcome: 'dispatch', outboundHosts: ['two.example'] }),
        },
        {
          name: 'the target runs its bound version on that version’s own script',
          change: () => sql.exec(`UPDATE scopes SET serving_ref = NULL WHERE scope_id = ?`, w.target),
          expect: (d) => expect(d).toMatchObject({ outcome: 'dispatch', deploymentRef: `${w.to}-v1`, outboundHosts: ['one.example'] }),
        },
        {
          name: 'that version’s manifest changes',
          change: () =>
            sql.exec(`UPDATE vertical_versions SET manifest_json = ? WHERE id = ?`, JSON.stringify({ outbound: ['three.example'] }), `${w.to}-v1`),
          expect: (d) => expect(d).toMatchObject({ outcome: 'dispatch', outboundHosts: ['three.example'] }),
        },
        {
          name: 'a second instance installed: ambiguous, so refused',
          change: () =>
            sql.exec(
              `INSERT INTO scopes (scope_id, tenant_id, slug, kind, name, vertical, vertical_version_id, serving_ref, created_at)
               VALUES (?, ?, 's-second', 'install', 'S', ?, ?, ?, ?)`,
              second, w.tenant, w.to, `${w.to}-v1`, `${w.to}-serving`, AT,
            ),
          expect: (d) => expect(d).toMatchObject({ outcome: 'refused', code: 'conflict' }),
        },
        {
          // The refusal took the entry out of the ledger, so the binding finds nothing to re-dirty:
          // the next miss asks again, and that is what publishes it.
          name: 'the caller binds the second instance, and the router asks again',
          change: () => {
            sql.exec(
              `INSERT INTO peer_bindings (tenant_id, caller_scope_id, vertical, target_scope_id) VALUES (?, ?, ?, ?)`,
              w.tenant, w.caller, w.to, second,
            );
            ask();
          },
          expect: (d) => expect(d).toMatchObject({ outcome: 'dispatch', scopeId: second }),
        },
        {
          name: 'the bound instance suspended',
          change: () => sql.exec(`UPDATE scopes SET status = 'suspended' WHERE scope_id = ?`, second),
          expect: (d) => expect(d).toMatchObject({ outcome: 'refused', code: 'conflict' }),
        },
        {
          name: 'the binding cleared and the second instance reaped: one instance again, asked again',
          change: () => {
            sql.exec(`DELETE FROM peer_bindings WHERE caller_scope_id = ?`, w.caller);
            sql.exec(`DELETE FROM scopes WHERE scope_id = ?`, second);
            ask();
          },
          expect: (d) => expect(d).toMatchObject({ outcome: 'dispatch', scopeId: w.target }),
        },
        {
          name: 'the caller suspended',
          change: () => sql.exec(`UPDATE scopes SET status = 'suspended' WHERE scope_id = ?`, w.caller),
          expect: (d) => expect(d).toMatchObject({ outcome: 'refused', code: 'forbidden' }),
        },
        {
          name: 'the caller live again and asked, then its tenant suspended',
          change: () => {
            sql.exec(`UPDATE scopes SET status = 'active' WHERE scope_id = ?`, w.caller);
            ask();
            sql.exec(`UPDATE tenants SET status = 'suspended' WHERE tenant_id = ?`, w.tenant);
          },
          expect: (d) => expect(d).toMatchObject({ outcome: 'refused', code: 'forbidden' }),
        },
      ];
      for (const step of steps) {
        step.change();
        await dir.settleRouteReadModel();
        const direct = await decide(w.peer, w.to, dir.peerCallTarget(w.tenant, w.caller, w.from, w.to));
        step.expect(direct);
        // A dispatch is published and decides the same; a refusal is not in KV at all.
        expect(await fromModel(w), step.name).toEqual(direct.outcome === 'dispatch' ? direct : 'miss');
      }
    });
  });

  it('never publishes a call to or from a residency-pinned scope (K-36)', async () => {
    await runInDurableObject(stub(), async (instance, state) => {
      const dir = instance as unknown as Directory;
      const w = seed(state.storage.sql, { jurisdiction: 'eu' });
      expect(dir.peerCallTarget(w.tenant, w.caller, w.from, w.to, { publish: true })).toMatchObject({ outcome: 'resolved' });
      await dir.settleRouteReadModel();
      expect(await env.TEST_ROUTES.get(peerCallKvKey(w.key))).toBeNull();
      // Pinned after it was published: the entry goes.
      state.storage.sql.exec(`UPDATE scopes SET jurisdiction = NULL WHERE scope_id = ?`, w.target);
      dir.peerCallTarget(w.tenant, w.caller, w.from, w.to, { publish: true });
      await dir.settleRouteReadModel();
      expect(await env.TEST_ROUTES.get(peerCallKvKey(w.key))).not.toBeNull();
      state.storage.sql.exec(`UPDATE scopes SET jurisdiction = 'eu' WHERE scope_id = ?`, w.caller);
      await dir.settleRouteReadModel();
      expect(await env.TEST_ROUTES.get(peerCallKvKey(w.key))).toBeNull();
    });
  });

  it('is inert until a router asks: no peer key is queued, and adding its triggers re-marks no route', async () => {
    await runInDurableObject(stub(), async (instance, state) => {
      const dir = instance as unknown as Directory;
      const sql = state.storage.sql;
      const w = seed(sql);
      // An answer read without `publish`, as every router with PEER_READ_MODEL off reads it.
      dir.peerCallTarget(w.tenant, w.caller, w.from, w.to);
      await dir.settleRouteReadModel();
      sql.exec(`UPDATE scopes SET status = 'suspended' WHERE scope_id = ?`, w.target);
      const peerKeys = () => sql.exec(`SELECT COUNT(*) AS n FROM route_read_model_outbox WHERE key >= 'c:' AND key < 'c;'`).one()['n'];
      expect(peerKeys()).toBe(0);
      await dir.settleRouteReadModel();
      expect(await env.TEST_ROUTES.get(peerCallKvKey(w.key))).toBeNull();

      // The deploy that brings the peer triggers to a directory whose routes are published.
      for (const { name } of sql.exec(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name GLOB 'rrm_peer_*'`).toArray()) {
        sql.exec(`DROP TRIGGER ${String(name)}`);
      }
      const unused: RouteKvWriter = { get: async () => null, put: async () => {}, delete: async () => {} };
      expect(new RouteReadModelPublisher(sql, unused).install()).toBe(false);
      expect(sql.exec(`SELECT COUNT(*) AS n FROM route_read_model_outbox`).one()['n']).toBe(0);
    });
  });

  it('a call the router misses is published on its first ask, across requests', async () => {
    const w = await runInDurableObject(stub(), async (instance, state) => {
      const world = seed(state.storage.sql);
      await (instance as unknown as Directory).settleRouteReadModel();
      return world;
    });
    // Real requests through the router's resolver: none of them meets a stub an earlier one created.
    const url = `https://router.test/peer-read-model?target=${encodeURIComponent(w.to)}&caller=${encodeURIComponent(JSON.stringify(w.peer))}`;
    for (let i = 0; i < 3; i++) {
      const res = await SELF.fetch(url);
      expect(await res.json()).toMatchObject({ outcome: 'dispatch', scopeId: w.target });
    }
    await runInDurableObject(stub(), async (instance) => (instance as unknown as Directory).settleRouteReadModel());
    expect(await env.TEST_ROUTES.get(peerCallKvKey(w.key), 'json')).toMatchObject({ peer: true, target: { scope_id: w.target } });
  });
});
