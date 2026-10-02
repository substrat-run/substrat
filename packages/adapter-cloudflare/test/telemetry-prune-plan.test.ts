import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { telemetryRetentionStatements, ulid } from '@substrat-run/kernel';
import { warmControlPlane } from './do-warmup.js';

/**
 * #1632, Durable Object half: the scheduled telemetry prune reaches each table's expired rows
 * through that table's retention index, on the SQLite a directory DO actually runs. A batch
 * bound only pays off if the subquery picking the batch is a range read on the index.
 */
const INDEX_OF = {
  opsFailures: '_substrat_ops_failures_at',
  issues: '_substrat_issues_seen',
  sweepRuns: '_substrat_sweep_runs_at',
} as const;

describe('#1632: telemetry retention query plans on a directory DO', () => {
  beforeAll(async () => {
    await warmControlPlane(env.CONTROL_PLANE);
  });

  it('picks every table\'s batch through its retention index, and scans nothing', async () => {
    const stub = env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName(`telemetry-plan-${ulid()}`));
    const plans = await runInDurableObject(stub, (_instance, state) =>
      telemetryRetentionStatements(Date.now(), 500).map(({ table, sql, params }) => ({
        table,
        detail: state.storage.sql
          .exec(`EXPLAIN QUERY PLAN ${sql}`, ...params)
          .toArray()
          .map((r) => String(r['detail'])),
      })),
    );
    expect(plans).toHaveLength(3);
    for (const { table, detail } of plans) {
      const index = INDEX_OF[table];
      expect(detail.some((d) => d.includes(`USING INDEX ${index}`) || d.includes(`USING COVERING INDEX ${index}`))).toBe(true);
      expect(detail.filter((d) => /^SCAN /.test(d))).toEqual([]);
    }
  });
});
