import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { ulid } from '@substrat-run/kernel';
import type { RouteTarget } from '@substrat-run/contracts';
import { toRouteTarget, type RouteRowLike } from '../src/route-resolver.js';
import { readModelRouteReader, RouteMemoryCache, routeKvKey } from '../src/route-read-model.js';
import { ROUTE_LEDGER_MARKER_KEY, RouteReadModelPublisher, type RouteKvWriter } from '../src/route-read-model-publisher.js';
import { warmDurableObject } from './do-warmup.js';

/**
 * #3395: the routing read model. The control plane publishes every route to KV and the router
 * reads it there. The oracle throughout is the directory's own `readRoute`: whatever a change did,
 * the read model must assemble to exactly what the directory answers.
 */

interface Directory {
  readRoute(hostname: string, opts?: { publish?: boolean }): RouteRowLike | undefined;
  settleRouteReadModel(): Promise<void>;
  reconcileRouteReadModel(opts?: { limit?: number }): Promise<{ checked: number; queued: number } | null>;
  exportDump(): Promise<unknown[]>;
  importDump(tables: unknown[]): Promise<void>;
  upsertHostname(h: {
    hostname: string; tenantId: string; scopeId: string; verticalSlug: string | null;
    surface: string; region: string | null; canonical: boolean; createdAt: string;
  }): void;
  setHostnameStatus(hostname: string, status: string, note: string | null): boolean;
}

const AT = '2026-11-25T00:00:00.000Z';
const ns = () => env.ROUTES_CONTROL_PLANE;
/** The resolver names the directory by its singleton name, so the suite shares that one object. */
const stub = () => ns().get(ns().idFromName('control-plane'));

/** What the read model resolves, through the router's own reader with a cold memory. */
async function fromModel(hostname: string): Promise<RouteTarget | undefined> {
  const row = await readModelRouteReader({ kv: env.TEST_ROUTES, cache: new RouteMemoryCache() })(hostname);
  return row === 'miss' ? undefined : toRouteTarget(row);
}

interface World {
  tenant: string;
  scope: string;
  host: string;
  vertical: string;
}

/** A tenant, a vertical with two admitted versions (serving the first), a scope on its script. */
function seed(sql: SqlStorage, opts: { jurisdiction?: string | null; hostStatus?: string } = {}): World {
  const id = ulid().toLowerCase();
  const w: World = { tenant: ulid(), scope: ulid(), host: `app-${id}.example.com`, vertical: `rrm-${id}` };
  const manifest = (host: string, store: string) =>
    JSON.stringify({ outbound: [host], calls: [], scopeStores: [{ binding: store, driver: 'graph' }] });
  sql.exec(`INSERT INTO tenants (tenant_id, slug, name, created_at) VALUES (?, ?, 'T', ?)`, w.tenant, `t-${id}`, AT);
  for (const [n, host, store] of [['1', 'one.example', 'ONE'], ['2', 'two.example', 'TWO']] as const) {
    sql.exec(
      `INSERT INTO vertical_versions (id, vertical_slug, version, manifest_digest, permission_digest, migration_digest,
         admission, created_at, deployment_ref, manifest_json)
       VALUES (?, ?, ?, 'm', 'p', 'g', 'admitted', ?, ?, ?)`,
      `${w.vertical}-v${n}`, w.vertical, `1.0.${n}`, AT, `${w.vertical}-v${n}`, manifest(host, store),
    );
  }
  sql.exec(
    `INSERT INTO verticals (slug, name, source, created_at, serving_ref, serving_version_id) VALUES (?, ?, 'cli', ?, ?, ?)`,
    w.vertical, w.vertical, AT, `${w.vertical}-serving`, `${w.vertical}-v1`,
  );
  sql.exec(
    `INSERT INTO scopes (scope_id, tenant_id, slug, kind, name, vertical, vertical_version_id, serving_ref, jurisdiction, created_at)
     VALUES (?, ?, 'main', 'install', 'Main', ?, ?, ?, ?, ?)`,
    w.scope, w.tenant, w.vertical, `${w.vertical}-v1`, `${w.vertical}-serving`, opts.jurisdiction ?? null, AT,
  );
  sql.exec(
    `INSERT INTO hostnames (hostname, tenant_id, scope_id, vertical_slug, surface, region, status, created_at)
     VALUES (?, ?, ?, ?, 'app', NULL, ?, ?)`,
    w.host, w.tenant, w.scope, w.vertical, opts.hostStatus ?? 'active', AT,
  );
  return w;
}

describe('#3395: the routing read model', () => {
  beforeAll(async () => {
    await warmDurableObject(async () => (stub() as unknown as Directory).readRoute('warm.example.com'));
  });

  it('every kind of change moves the read model to what the directory answers', async () => {
    await runInDurableObject(stub(), async (instance, state) => {
      const dir = instance as unknown as Directory;
      const sql = state.storage.sql;
      const w = seed(sql, { hostStatus: 'pending' });
      const sibling = `admin-${w.host}`;
      const steps: Array<{ name: string; change: () => void; expect: (t: RouteTarget | undefined) => void; kv?: unknown }> = [
        // A hostname not active itself has no entry: the directory answers it, so its activation is not held up.
        { name: 'a pending hostname routes nowhere', change: () => {}, expect: (t) => expect(t).toBeUndefined(), kv: null },
        {
          name: 'hostname activated',
          change: () => sql.exec(`UPDATE hostnames SET status = 'active' WHERE hostname = ?`, w.host),
          expect: (t) => expect(t).toMatchObject({ deploymentRef: `${w.vertical}-serving`, outboundHosts: ['one.example'], primary: true }),
        },
        {
          name: 'a second hostname bound to the scope',
          change: () =>
            sql.exec(
              `INSERT INTO hostnames (hostname, tenant_id, scope_id, vertical_slug, surface, region, status, created_at)
               VALUES (?, ?, ?, ?, 'admin', NULL, 'active', ?)`,
              sibling, w.tenant, w.scope, w.vertical, AT,
            ),
          expect: (t) => expect(t?.hostnames).toEqual([sibling, w.host].sort()),
        },
        {
          name: 'promote: the serving version moves, and no route is rewritten for it',
          change: () => sql.exec(`UPDATE verticals SET serving_version_id = ? WHERE slug = ?`, `${w.vertical}-v2`, w.vertical),
          expect: (t) => expect(t).toMatchObject({ outboundHosts: ['two.example'], scopeStores: [{ binding: 'TWO', driver: 'graph' }] }),
        },
        {
          name: 'the scope moves to another serving script (no stores off the current one)',
          change: () => sql.exec(`UPDATE scopes SET serving_ref = 'elsewhere' WHERE scope_id = ?`, w.scope),
          expect: (t) => expect(t).toMatchObject({ deploymentRef: 'elsewhere', outboundHosts: ['two.example'], scopeStores: [] }),
        },
        {
          name: 'the scope runs its bound version on that version\'s own script',
          change: () => sql.exec(`UPDATE scopes SET serving_ref = NULL WHERE scope_id = ?`, w.scope),
          expect: (t) => expect(t).toMatchObject({ deploymentRef: `${w.vertical}-v1`, outboundHosts: ['one.example'] }),
        },
        {
          name: 'the scope becomes a preview: inert, and still routed',
          change: () => sql.exec(`UPDATE scopes SET kind = 'preview' WHERE scope_id = ?`, w.scope),
          expect: (t) => expect(t).toMatchObject({ primary: false }),
        },
        {
          name: 'the scope suspended',
          change: () => sql.exec(`UPDATE scopes SET status = 'suspended' WHERE scope_id = ?`, w.scope),
          expect: (t) => expect(t).toBeUndefined(),
          // Refused at the edge: an entry that says so, not a miss the directory must answer.
          kv: { v: 1, refused: true },
        },
        {
          name: 'the scope live again, its tenant suspended',
          change: () => {
            sql.exec(`UPDATE scopes SET status = 'active' WHERE scope_id = ?`, w.scope);
            sql.exec(`UPDATE tenants SET status = 'suspended' WHERE tenant_id = ?`, w.tenant);
          },
          expect: (t) => expect(t).toBeUndefined(),
          kv: { v: 1, refused: true },
        },
        {
          name: 'the tenant live again, the hostname removed',
          change: () => {
            sql.exec(`UPDATE tenants SET status = 'active' WHERE tenant_id = ?`, w.tenant);
            sql.exec(`DELETE FROM hostnames WHERE hostname = ?`, w.host);
          },
          expect: (t) => expect(t).toBeUndefined(),
          // Gone from the directory, gone from KV: no refusal lingers for a name nobody holds.
          kv: null,
        },
        {
          name: 'the scope reaped: its remaining hostname routes nowhere',
          change: () => sql.exec(`DELETE FROM scopes WHERE scope_id = ?`, w.scope),
          expect: () => {},
        },
      ];
      for (const step of steps) {
        step.change();
        await dir.settleRouteReadModel();
        const direct = toRouteTarget(dir.readRoute(w.host));
        const modelled = await fromModel(w.host);
        expect(modelled, step.name).toEqual(direct);
        step.expect(modelled);
        if (step.kv !== undefined) expect(await env.TEST_ROUTES.get(routeKvKey(w.host), 'json'), step.name).toEqual(step.kv);
        // The sibling's route moves with every scope-level change too.
        expect(await fromModel(sibling), `${step.name} (sibling)`).toEqual(toRouteTarget(dir.readRoute(sibling)));
      }
      // The sibling's row outlived its scope: an active name that routes nowhere is refused at the edge.
      expect(await env.TEST_ROUTES.get(routeKvKey(sibling), 'json')).toEqual({ v: 1, refused: true });
    });
  });

  it('never publishes a residency-pinned route, and the directory still answers it (K-36)', async () => {
    await runInDurableObject(stub(), async (instance, state) => {
      const dir = instance as unknown as Directory;
      const w = seed(state.storage.sql, { jurisdiction: 'eu' });
      // The router's miss asks to publish; a pinned route is not even queued.
      expect(dir.readRoute(w.host, { publish: true })).toMatchObject({ scope_id: w.scope });
      await dir.settleRouteReadModel();
      expect(await env.TEST_ROUTES.get(routeKvKey(w.host))).toBeNull();
      expect(state.storage.sql.exec(`SELECT COUNT(*) AS n FROM route_read_model_outbox`).one()).toEqual({ n: 0 });
    });
  });

  it('names no pinned hostname in any KV value: a scope holding one publishes no route at all', async () => {
    await runInDurableObject(stub(), async (instance, state) => {
      const dir = instance as unknown as Directory;
      const w = seed(state.storage.sql);
      await dir.settleRouteReadModel();
      expect(await env.TEST_ROUTES.get(routeKvKey(w.host))).not.toBeNull();
      // A pinned sibling joins the scope: the unpinned route would list its name, so it goes.
      const pinned = `eu-${w.host}`;
      state.storage.sql.exec(
        `INSERT INTO hostnames (hostname, tenant_id, scope_id, vertical_slug, surface, region, status, created_at)
         VALUES (?, ?, ?, ?, 'eu', 'eu', 'active', ?)`,
        pinned, w.tenant, w.scope, w.vertical, AT,
      );
      const before = (dir as unknown as { routeReadModelStatus(): Record<string, number> }).routeReadModelStatus();
      await dir.settleRouteReadModel();
      expect(await env.TEST_ROUTES.get(routeKvKey(w.host))).toBeNull();
      expect(dir.readRoute(w.host)).toMatchObject({ scope_hostnames: [pinned, w.host].sort() });
      // The dry run counts by the same rule: both names are now left to the directory, none routable.
      state.storage.sql.exec(`UPDATE scopes SET status = 'suspended' WHERE scope_id = ?`, w.scope);
      const after = (dir as unknown as { routeReadModelStatus(): Record<string, number> }).routeReadModelStatus();
      expect({ routable: after['routable']! - before['routable']!, refused: after['refused']! - before['refused']! })
        .toEqual({ routable: 0, refused: 1 });
    });
  });

  it('a write KV took and the ledger never confirmed is undone when the route goes', async () => {
    await runInDurableObject(stub(), async (instance, state) => {
      const dir = instance as unknown as Directory;
      const w = seed(state.storage.sql);
      await dir.settleRouteReadModel();
      // The object stopped between KV accepting the put and the ledger confirming it.
      state.storage.sql.exec(`UPDATE route_read_model_published SET digest = 'uncertain' WHERE key = ?`, `h:${w.host}`);
      state.storage.sql.exec(`DELETE FROM hostnames WHERE hostname = ?`, w.host);
      await dir.settleRouteReadModel();
      expect(await env.TEST_ROUTES.get(routeKvKey(w.host))).toBeNull();
    });
  });

  it('a route the directory holds and KV does not is published when the router misses it', async () => {
    const w = await runInDurableObject(stub(), async (instance, state) => {
      const dir = instance as unknown as Directory;
      const world = seed(state.storage.sql);
      await dir.settleRouteReadModel();
      // As before a backfill: in the directory, nowhere in KV.
      await env.TEST_ROUTES.delete(routeKvKey(world.host));
      state.storage.sql.exec(`DELETE FROM route_read_model_published WHERE key = ?`, `h:${world.host}`);
      return world;
    });
    // Three real requests through the router's resolver: the first misses and asks the directory,
    // and none of them meets a stub an earlier request created ("Cannot perform I/O…").
    for (let i = 0; i < 3; i++) {
      const res = await SELF.fetch(`https://router.test/route-read-model?host=${w.host}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ tenantId: w.tenant, scopeId: w.scope });
    }
    await runInDurableObject(stub(), async (instance) => (instance as unknown as Directory).settleRouteReadModel());
    expect(await env.TEST_ROUTES.get(routeKvKey(w.host), 'json')).toMatchObject({ scope_id: w.scope });
  });

  it('a directory method publishes its own writes, with nobody asking', async () => {
    const w = await runInDurableObject(stub(), async (instance, state) => {
      const world = seed(state.storage.sql);
      await (instance as unknown as Directory).settleRouteReadModel();
      return world;
    });
    const added = `rpc-${w.host}`;
    // Over RPC, the way the control plane's coordinator calls it: the publish follows the call.
    const directory = stub() as unknown as Directory;
    await directory.upsertHostname({
      hostname: added, tenantId: w.tenant, scopeId: w.scope, verticalSlug: w.vertical,
      surface: 'rpc', region: null, canonical: false, createdAt: AT,
    });
    await directory.setHostnameStatus(added, 'active', null);
    await expect.poll(() => env.TEST_ROUTES.get(routeKvKey(w.host), 'json'), { timeout: 2_000 }).toMatchObject({
      scope_hostnames: [added, w.host].sort(),
    });
  });

  it('a restore re-publishes the restored directory and deletes what it no longer routes', async () => {
    await runInDurableObject(stub(), async (instance, state) => {
      const dir = instance as unknown as Directory;
      const kept = seed(state.storage.sql);
      await dir.settleRouteReadModel();
      const dump = await dir.exportDump();
      expect((dump as Array<{ name: string }>).map((t) => t.name).filter((n) => n.startsWith('route_read_model'))).toEqual([]);
      const later = seed(state.storage.sql);
      await dir.settleRouteReadModel();
      expect(await env.TEST_ROUTES.get(routeKvKey(later.host))).not.toBeNull();

      await dir.importDump(dump);
      await dir.settleRouteReadModel();
      expect(await env.TEST_ROUTES.get(routeKvKey(later.host))).toBeNull();
      expect(await fromModel(kept.host)).toEqual(toRouteTarget(dir.readRoute(kept.host)));
      expect(await fromModel(kept.host)).toMatchObject({ scopeId: kept.scope });
    });
  });

  it('refuses a restore whose dump names a read-model table, in any case, before touching anything', async () => {
    await runInDurableObject(stub(), async (instance, state) => {
      const dir = instance as unknown as Directory;
      const w = seed(state.storage.sql);
      await dir.settleRouteReadModel();
      const name = 'Route_Read_Model_Published';
      const crafted = {
        name,
        ddl: `CREATE TABLE ${name} (key TEXT PRIMARY KEY, digest TEXT NOT NULL, at TEXT NOT NULL)`,
        columns: ['key', 'digest', 'at'],
        rows: [[`h:${w.host}`, 'forged', AT]],
      };
      await expect(dir.importDump([...(await dir.exportDump()), crafted])).rejects.toThrow(/route_read_model_published/i);
      // Nothing was dropped or loaded: the ledger still holds the real digest.
      const row = state.storage.sql.exec(`SELECT digest FROM route_read_model_published WHERE key = ?`, `h:${w.host}`).one();
      expect(row['digest']).not.toBe('forged');
      expect(await fromModel(w.host)).toEqual(toRouteTarget(dir.readRoute(w.host)));
    });
  });

  it('a key KV keeps refusing goes to the back and does not hold back the one queued behind it', async () => {
    await runInDurableObject(stub(), async (instance, state) => {
      const dir = instance as unknown as Directory;
      const stuck = seed(state.storage.sql);
      const healthy = seed(state.storage.sql);
      await dir.settleRouteReadModel();
      const sql = state.storage.sql;
      // Both re-dirtied, the refused one first in the queue.
      sql.exec(`UPDATE route_read_model_published SET digest = 'uncertain' WHERE key IN (?, ?)`, `h:${stuck.host}`, `h:${healthy.host}`);
      await env.TEST_ROUTES.delete(routeKvKey(healthy.host));
      sql.exec(`INSERT INTO route_read_model_outbox (key) VALUES (?), (?)`, `h:${stuck.host}`, `h:${healthy.host}`);
      const refusing: RouteKvWriter = {
        get: (k) => env.TEST_ROUTES.get(k),
        put: async (k, v) => {
          if (k === routeKvKey(stuck.host)) throw new Error('KV refused');
          await env.TEST_ROUTES.put(k, v);
        },
        delete: (k) => env.TEST_ROUTES.delete(k),
      };
      await expect(new RouteReadModelPublisher(sql, refusing).flush()).rejects.toThrow(/refused 1 key/);
      expect(await fromModel(healthy.host)).toEqual(toRouteTarget(dir.readRoute(healthy.host)));
      // The refused key is still queued, for the alarm's retry.
      expect(sql.exec(`SELECT COUNT(*) AS n FROM route_read_model_outbox WHERE key = ?`, `h:${stuck.host}`).one()).toEqual({ n: 1 });
    });
  });

  it('a namespace that is not the ledger’s (marker gone) has every entry published into it again', async () => {
    await runInDurableObject(stub(), async (instance, state) => {
      const dir = instance as unknown as Directory;
      const w = seed(state.storage.sql);
      await dir.settleRouteReadModel();
      // As if ROUTES were pointed at an empty namespace: the entry and the marker are gone.
      await env.TEST_ROUTES.delete(routeKvKey(w.host));
      await env.TEST_ROUTES.delete(ROUTE_LEDGER_MARKER_KEY);
      // What a restart (or the alarm, when the check had failed) runs.
      const reset = await new RouteReadModelPublisher(state.storage.sql, env.TEST_ROUTES as unknown as RouteKvWriter).verifyNamespace();
      expect(reset).toBe(true);
      await dir.settleRouteReadModel();
      expect(await fromModel(w.host)).toEqual(toRouteTarget(dir.readRoute(w.host)));
      expect(await env.TEST_ROUTES.get(ROUTE_LEDGER_MARKER_KEY)).not.toBeNull();
    });
  });

  it('the scheduled reconcile repairs an entry that drifted from the directory', async () => {
    await runInDurableObject(stub(), async (instance, state) => {
      const dir = instance as unknown as Directory;
      const w = seed(state.storage.sql);
      await dir.settleRouteReadModel();
      // A write that reached KV but not the ledger, or the reverse: the two disagree.
      await env.TEST_ROUTES.put(routeKvKey(w.host), JSON.stringify({ v: 1, drifted: true }));
      state.storage.sql.exec(`UPDATE route_read_model_published SET digest = 'drifted' WHERE key = ?`, `h:${w.host}`);
      // Every source, whole: the suite's directory is small.
      let queued = 0;
      for (let pass = 0; pass < 3; pass++) queued += (await dir.reconcileRouteReadModel({ limit: 1_000 }))?.queued ?? 0;
      expect(queued).toBeGreaterThan(0);
      // The reconcile starts the publish and does not wait for it; settling is the caller's choice.
      await dir.settleRouteReadModel();
      expect(await fromModel(w.host)).toEqual(toRouteTarget(dir.readRoute(w.host)));
    });
  });
});
