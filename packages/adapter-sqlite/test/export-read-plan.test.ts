import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { exportReadQuery, ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { permMod } from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';

/**
 * #1787, the node half: the export read's plan holds with and without table statistics. The
 * workerd half, on a real Durable Object's spine (`adapter-cloudflare/test/do-sql-limits.test.ts`),
 * is the one that matters. This one keeps the node adapter honest, since self-host and CI run it,
 * and it reads the REAL spine: a scope the host provisioned, so an index that drifts out of
 * `KERNEL_DDL` shows up here. Harness code: the scope's file is opened directly to seed it
 * and to run ANALYZE, both of which `ctx.sql` would refuse or not reach, as `invocation-index.test.ts` does.
 */
describe('exportReadQuery keeps the (type, id) index once statistics exist (#1787)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let db: Database.Database;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-export-read-plan-'));
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const staff = platformActorId.parse(ulid());
    host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)) });
    host.registerModule(permMod);
    await host.admin.createTenant(staff, { id: t, slug: `export-plan-${ulid().toLowerCase()}`, name: 'Export read plan' });
    await host.admin.grantEntitlement(staff, t, 'perm');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'perm-vertical' });
    await host.admin.activateScope(staff, t, s);
    db = new Database(join(dir, `${t}__${s}.sqlite`));
    db.prepare(
      `INSERT INTO _substrat_outbox (id, type, schema_version, occurred_at, tenant_id, scope_id, actor,
         entity_type, entity_id, pii_class)
       WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 19999)
       SELECT printf('01J%023d', i), 'probe.t' || (i % 50), 1, '2026-09-25T00:00:00.000Z', 't', 's', 'a', 'e',
              CAST(i AS TEXT), 'none' FROM n`,
    ).run();
  });
  afterAll(async () => {
    db.close();
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const wanted = ['probe.t1', 'probe.t2', 'probe.t3'];
  const cursor = `01J${String(5_000).padStart(23, '0')}`;
  const plan = (q: { sql: string; params: unknown[] }): string =>
    (db.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...q.params) as { detail: string }[]).map((r) => r.detail).join(' | ');
  const ids = (q: { sql: string; params: unknown[] }): string[] =>
    (db.prepare(q.sql).all(...q.params) as { id: string }[]).map((r) => r.id);
  const listed = `SELECT * FROM _substrat_outbox WHERE type IN (?, ?, ?) AND id > ? ORDER BY id LIMIT ?`;

  for (const phase of ['without statistics', 'after ANALYZE']) {
    it(`seeks (type, id) and reads what the listed form read (${phase})`, () => {
      if (phase === 'after ANALYZE') {
        db.exec('ANALYZE');
        expect(db.prepare('SELECT COUNT(*) AS c FROM sqlite_stat1').get()).toMatchObject({ c: expect.any(Number) });
      }
      const q = exportReadQuery([...wanted, 'probe.t1'], cursor, 1000);
      expect(plan(q)).toContain('_substrat_outbox_type_id (type=? AND id>?)');
      expect(plan(q)).not.toContain('sqlite_autoindex__substrat_outbox');
      expect(ids(q)).toEqual((db.prepare(listed).all(...wanted, cursor, 1000) as { id: string }[]).map((r) => r.id));
      expect(ids(q)).toHaveLength(3 * (20_000 / 50 - 100));
    });
  }
});
