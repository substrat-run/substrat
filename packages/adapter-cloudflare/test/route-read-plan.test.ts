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
