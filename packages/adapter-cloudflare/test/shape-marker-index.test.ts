import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { shapeReconcilePlans } from '@substrat-run/contract-tests';
import { ulid } from '@substrat-run/kernel';
import { switchSqlOver } from '../src/scope-do.js';

/**
 * #2083 on the SQLite a scope Durable Object runs: the shape reconcile reads markers on
 * `_substrat_tuples_shape_marker`, never by scanning the tuple table, and a DO built before the
 * index gets it on its next wake (KERNEL_DDL runs in the constructor, every wake). The probe in
 * `@substrat-run/contract-tests` drives the kernel's own passes over this DO's real schema and
 * has workerd plan every statement they send. adapter-sqlite's `shape-marker-index.test.ts` is
 * the same on node.
 */
const INDEX = '_substrat_tuples_shape_marker';

// A fresh `env.SCOPE.get` each time: `state.abort()` poisons the stub it was called through.
const stubOf = (name: string) => env.SCOPE.get(env.SCOPE.idFromName(name));
const indexSql = (sql: SqlStorage) =>
  sql.exec("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?", INDEX).toArray()[0]?.['sql'] ?? null;

function expectOnIndexes(name: string) {
  return runInDurableObject(stubOf(name), (_instance, state) => {
    const report = shapeReconcilePlans(switchSqlOver(state.storage.sql), { tenantId: ulid(), scopeId: ulid() });
    expect(report.complete).toBe(true);
    expect(report.passes).toBeGreaterThan(1);
    expect(report.walks.length).toBeGreaterThan(0);
    for (const plan of report.walks) {
      expect(plan).toMatch(new RegExp(`SEARCH m USING (COVERING )?INDEX ${INDEX} \\(\\(object,subject\\)>\\(\\?,\\?\\) AND object<\\?\\)`));
      expect(plan).not.toMatch(/TEMP B-TREE FOR ORDER BY/);
    }
    expect(report.backfills.length).toBeGreaterThan(0);
    for (const plan of report.backfills) expect(plan).toMatch(/SEARCH t USING (COVERING )?INDEX _substrat_tuples_object_relation_subject \(object>\? AND object<\?\)/);
    expect(report.scans).toEqual([]);
  });
}

describe('#2083: the shape reconcile reads markers on their own index, on workerd', () => {
  it('a new scope DO has the partial index, and every read a reconcile sends plans on an index', async () => {
    const name = `shape-marker-${ulid()}`;
    const ddl = await runInDurableObject(stubOf(name), (_instance, state) => indexSql(state.storage.sql));
    expect(ddl).toMatch(/ON _substrat_tuples \(object, subject\) WHERE relation = 'bootstrap'$/);
    await expectOnIndexes(name);
  });

  it('a DO built before the index gets it on its next wake, and its reads plan on it', async () => {
    const name = `shape-marker-legacy-${ulid()}`;
    const dropped = await runInDurableObject(stubOf(name), (_instance, state) => {
      state.storage.sql.exec(`DROP INDEX ${INDEX}`);
      return indexSql(state.storage.sql);
    });
    expect(dropped).toBeNull();
    // The eviction: `abort()` throws inside the DO by contract, and the next stub wakes it anew.
    await runInDurableObject(stubOf(name), (_instance, state) => {
      state.abort('evicted for #2083 test');
    }).catch(() => undefined);
    const woken = await runInDurableObject(stubOf(name), (_instance, state) => indexSql(state.storage.sql));
    expect(woken).toMatch(/WHERE relation = 'bootstrap'$/);
    await expectOnIndexes(name);
  });
});
