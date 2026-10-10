/**
 * The shape reconcile reads markers on their own index, on a new scope AND on one built before
 * the index existed (#2083).
 *
 * Every pass of a reconcile used to scan the whole `_substrat_tuples` table, even when it had
 * nothing to do, and a reconcile runs on every provision. `_substrat_tuples_shape_marker`
 * (markers only, `(object, subject)`) makes a shape's markers one range; the probe in
 * `@substrat-run/contract-tests` drives the kernel's own passes over this scope's real schema and
 * has better-sqlite3 plan every statement they send.
 *
 * Harness code: the scope's file is opened directly, as `invocation-index.test.ts` does, because
 * shaping a legacy schema is exactly what `ctx.sql` refuses.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox, type SwitchSql } from '@substrat-run/kernel';
import { permMod, shapeReconcilePlans } from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';

const INDEX = '_substrat_tuples_shape_marker';
const secretBox = () => webCryptoSecretBox('test-key', new Uint8Array(32).fill(7));
const staff = platformActorId.parse(ulid());

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function provisioned() {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-shape-marker-'));
  dirs.push(dir);
  const t1 = tenantId.parse(ulid());
  const s1 = scopeId.parse(ulid());
  const open = () => {
    const host = new SqliteScopeHost({ dir, secretBox: secretBox() });
    host.registerModule(permMod);
    return host;
  };
  const host = open();
  await host.admin.createTenant(staff, { id: t1, slug: `shape-marker-${ulid().toLowerCase()}`, name: 'Shape marker' });
  await host.admin.grantEntitlement(staff, t1, 'perm');
  await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'perm-vertical' });
  await host.admin.activateScope(staff, t1, s1);
  return { open, t1, s1, host, file: join(dir, `${t1}__${s1}.sqlite`) };
}

const withFile = <T>(file: string, f: (db: InstanceType<typeof Database>) => T): T => {
  const db = new Database(file);
  try {
    return f(db);
  } finally {
    db.close();
  }
};

const raw = (db: InstanceType<typeof Database>): SwitchSql => ({
  all: (sql, ...params) => db.prepare(sql).all(...params) as Record<string, unknown>[],
  run: (sql, ...params) => {
    db.prepare(sql).run(...params);
  },
});

const indexed = (db: InstanceType<typeof Database>) =>
  db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(INDEX) as { sql: string } | undefined;

/** What the plan of every statement a reconcile sends must say, on any scope. */
function expectOnIndexes(db: InstanceType<typeof Database>, ids: { tenantId: string; scopeId: string }) {
  const report = shapeReconcilePlans(raw(db), ids);
  expect(report.complete).toBe(true);
  expect(report.passes).toBeGreaterThan(1); // small passes, so the cursor is what finished it
  expect(report.walks.length).toBeGreaterThan(0);
  for (const plan of report.walks) expect(plan).toMatch(new RegExp(`SEARCH m USING (COVERING )?INDEX ${INDEX} \\(\\(object,subject\\)>\\(\\?,\\?\\) AND object<\\?\\)`));
  // The index order IS the walk's order: no sort, which would read the whole range first.
  for (const plan of report.walks) expect(plan).not.toMatch(/TEMP B-TREE FOR ORDER BY/);
  expect(report.backfills.length).toBeGreaterThan(0);
  for (const plan of report.backfills) expect(plan).toMatch(/SEARCH t USING (COVERING )?INDEX _substrat_tuples_object_relation_subject \(object>\? AND object<\?\)/);
  expect(report.scans).toEqual([]);
}

describe('the shape reconcile reads markers on their own index (#2083)', () => {
  it('a new scope has the partial index, and every read a reconcile sends plans on an index', async () => {
    const { host, file, t1, s1 } = await provisioned();
    await host.close();
    withFile(file, (db) => {
      expect(indexed(db)?.sql).toMatch(/ON _substrat_tuples \(object, subject\) WHERE relation = 'bootstrap'$/);
      expectOnIndexes(db, { tenantId: t1, scopeId: s1 });
    });
  });

  it('a scope built before the index gets it on its next wake, and its reads plan on it', async () => {
    const { host, open, file, t1, s1 } = await provisioned();
    await host.close();
    withFile(file, (db) => {
      db.exec(`DROP INDEX ${INDEX}`);
      expect(indexed(db)).toBeUndefined();
    });
    const woken = open();
    await woken.admin.reconcileEntityGrantShapes(staff, { tenantId: t1, scopeId: s1 }, []); // any call wakes the scope
    await woken.close();
    withFile(file, (db) => {
      expect(indexed(db)).toBeDefined();
      expectOnIndexes(db, { tenantId: t1, scopeId: s1 });
    });
  });
});
