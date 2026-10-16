import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { ulid } from '@substrat-run/kernel';
import { READ_ROUTE_SQL } from '../src/control-plane-do.js';
import { warmControlPlane } from './do-warmup.js';

/**
 * #2005: the router's per-request directory read now carries the scope's own hostnames — a
 * correlated subquery on the hot path every request takes. On the SQLite a directory DO runs, it
 * must be a range read on `hostnames_scope`, never a scan of the hostname table.
 */
describe('#2005: the route read plans its scope-hostname set on the index', () => {
  beforeAll(async () => {
    await warmControlPlane(env.CONTROL_PLANE);
  });

  it('reads the hostname set through hostnames_scope, and scans no hostnames table', async () => {
    const stub = env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName(`route-plan-${ulid()}`));
    const detail = await runInDurableObject(stub, async (instance, state) => {
      // Any read builds the directory schema; the plan is asked of the real tables.
      await (instance as unknown as { readRoute(h: string): unknown }).readRoute('warm.example.com');
      return state.storage.sql
        .exec(`EXPLAIN QUERY PLAN ${READ_ROUTE_SQL}`, 'plan.example.com')
        .toArray()
        .map((r) => String(r['detail']));
    });
    expect(detail.some((d) => /^SEARCH hostnames USING (COVERING )?INDEX hostnames_scope \(scope_id=\?\)/.test(d))).toBe(true);
    // Not through the status index: that reads every active hostname in the fleet.
    expect(detail.filter((d) => d.includes('hostnames_status'))).toEqual([]);
    expect(detail.filter((d) => /^SCAN (h|s|t|hostnames|scopes|tenants)\b/.test(d))).toEqual([]);
  });
});

/**
 * #2207: the route read names a scope's stores from the version its script runs. A scope on its
 * vertical's current serving script runs the serving version; a scope pinned to another script
 * (stamped at provision, a fork kept on its copy's script) runs one the row cannot name, so it is
 * given no store rather than the pointer's. The control plane reads the same rule (`scopeStoresOf`).
 */
describe('#2207: the route read takes a scope\'s stores from the version its script runs', () => {
  beforeAll(async () => {
    await warmControlPlane(env.CONTROL_PLANE);
  });

  it('the serving version on the current pin, the bound version off it, none on another script', async () => {
    const stub = env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName(`route-stores-${ulid()}`));
    const rows = await runInDurableObject(stub, async (instance, state) => {
      await (instance as unknown as { readRoute(h: string): unknown }).readRoute('warm.example.com');
      const sql = state.storage.sql;
      const at = '2026-10-13T00:00:00.000Z';
      const manifest = (binding: string) => JSON.stringify({ scopeStores: [{ binding, driver: 'graph' }] });
      const tenant = ulid();
      sql.exec(`INSERT INTO tenants (tenant_id, slug, name, created_at) VALUES (?, ?, 'T', ?)`, tenant, `t-${tenant.toLowerCase()}`, at);
      sql.exec(`INSERT INTO verticals (slug, name, source, created_at) VALUES ('graphy', 'graphy', 'cli', ?)`, at);
      for (const [id, binding] of [['served', 'SERVED'], ['bound', 'BOUND']] as const) {
        sql.exec(
          `INSERT INTO vertical_versions (id, vertical_slug, version, manifest_digest, permission_digest, migration_digest,
             admission, created_at, deployment_ref, manifest_json)
           VALUES (?, 'graphy', ?, 'm', 'p', 'g', 'admitted', ?, ?, ?)`,
          id, `1.0.${id}`, at, `graphy-${id}`, manifest(binding),
        );
      }
      sql.exec(`UPDATE verticals SET serving_ref = 'graphy-stable', serving_version_id = 'served' WHERE slug = 'graphy'`);
      const read = (servingRef: string | null) => {
        const scope = ulid();
        const host = `${scope.toLowerCase()}.example.com`;
        sql.exec(
          `INSERT INTO scopes (scope_id, tenant_id, vertical, status, serving_ref, vertical_version_id, created_at)
           VALUES (?, ?, 'graphy', 'active', ?, 'bound', ?)`,
          scope, tenant, servingRef, at,
        );
        sql.exec(
          `INSERT INTO hostnames (hostname, tenant_id, scope_id, vertical_slug, surface, status, created_at)
           VALUES (?, ?, ?, 'graphy', 'app', 'active', ?)`,
          host, tenant, scope, at,
        );
        const row = sql.exec(READ_ROUTE_SQL, host).toArray()[0] as { scope_stores_json: string | null } | undefined;
        return row ? row.scope_stores_json : 'no row';
      };
      return { pinned: read('graphy-stable'), unpinned: read(null), elsewhere: read('graphy-older') };
    });
    expect(rows.pinned).toBe(JSON.stringify([{ binding: 'SERVED', driver: 'graph' }]));
    expect(rows.unpinned).toBe(JSON.stringify([{ binding: 'BOUND', driver: 'graph' }]));
    expect(rows.elsewhere).toBeNull();
  });
});
