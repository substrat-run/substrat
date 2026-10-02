import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { telemetryRetentionStatements } from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

/**
 * #1632: the scheduled telemetry prune reaches each table's expired rows through that
 * table's retention index. A batch bound only pays off if the subquery that picks the batch
 * is a range read on the index, not a scan of a table that may hold a year of backlog.
 */
const INDEX_OF = {
  opsFailures: '_substrat_ops_failures_at',
  issues: '_substrat_issues_seen',
  sweepRuns: '_substrat_sweep_runs_at',
} as const;

describe('#1632: telemetry retention query plans', () => {
  let dir: string;
  let db: Database.Database;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-telemetry-plan-'));
    await new SqliteScopeHost({ dir }).close();
    db = new Database(join(dir, '_directory.sqlite'), { readonly: true });
  });

  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  for (const { table, sql, params } of telemetryRetentionStatements(Date.now(), 500)) {
    it(`${table}: picks its batch through ${INDEX_OF[table]}, and scans nothing`, () => {
      const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map((r) => r.detail);
      expect(plan.some((d) => d.includes(`USING INDEX ${INDEX_OF[table]}`) || d.includes(`USING COVERING INDEX ${INDEX_OF[table]}`))).toBe(true);
      expect(plan.filter((d) => /^SCAN /.test(d))).toEqual([]);
    });
  }
});
