import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { PRE_GUARD_REFUSALS_DDL } from '@substrat-run/contract-tests';
import { ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

/**
 * #1745: a scope whose `_substrat_refusals` is the shape #1928 shipped — `from_state NOT
 * NULL`, no `guard` or `reason` — woken by code that records guard refusals. The table is
 * rebuilt on contact (`REFUSALS_REBUILD`), keeping every transition row and the index; the
 * Durable Object twin is in `adapter-cloudflare/test/schedule-invocation-column.test.ts`.
 *
 * Three wakes, as #1288's test has, because "it ran" and "it ran once" are different facts:
 * a guard row written after the first must survive the next two untouched.
 */
describe('#1745: a pre-guard refusals table is rebuilt to admit guard rows, once', () => {
  it('keeps every transition row and the index, and the wakes after change nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'substrat-refusals-rebuild-'));
    try {
      const staff = platformActorId.parse(ulid());
      const t = tenantId.parse(ulid());
      const s = scopeId.parse(ulid());
      const p = principalId.parse(ulid());

      let host = new SqliteScopeHost({ dir });
      await host.admin.createTenant(staff, { id: t, slug: 'refusals-rebuild', name: 'Refusals' });
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'v' });
      await host.admin.activateScope(staff, t, s);
      await host.close();

      const file = join(dir, `${t}__${s}.sqlite`);
      const db = new Database(file);
      db.exec('DROP TABLE _substrat_refusals');
      db.exec(PRE_GUARD_REFUSALS_DDL);
      const insert = db.prepare(
        `INSERT INTO _substrat_refusals (id, kind, tenant_id, scope_id, entity_type, entity_id, from_state,
           attempted_state, operation, invoked_operation, actor, impersonation, invocation_id, at, drained_at)
         VALUES (?, 'transition', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      // Two rows that differ in every nullable column, so a dropped or shuffled column fails.
      insert.run(ulid(), t, s, 'order', 'o1', 'closed', 'open', 'shop/reopen', 'shop/reopen', JSON.stringify(p), null, 'inv-1', '2026-09-30T10:00:00.000Z', null);
      insert.run(ulid(), t, s, null, null, 'done', null, 'test/move', 'test/move', JSON.stringify(p), '{"staff":"x"}', null, '2026-09-30T11:00:00.000Z', '2026-10-01T00:00:00.000Z');
      const before = db.prepare('SELECT * FROM _substrat_refusals ORDER BY id').all();
      const indexes = () =>
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = '_substrat_refusals' ORDER BY name").all();
      const indexesBefore = indexes();
      expect(indexesBefore).toContainEqual({ name: '_substrat_refusals_entity_at' });
      db.close();

      let afterFirst: unknown[] = [];
      for (let wake = 1; wake <= 3; wake += 1) {
        host = new SqliteScopeHost({ dir });
        await host.getScope(p, t, s);
        if (wake === 1) {
          const read = await host.admin.listRefusals(staff, t, s);
          expect(read.map((r) => [r.kind, r.reason, r.guard, r.fromState])).toEqual([
            ['transition', 'invalid_transition', null, 'done'],
            ['transition', 'invalid_transition', null, 'closed'],
          ]);
        }
        await host.close();

        const after = new Database(file);
        expect(
          (after.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = '_substrat_refusals'").get() as { sql: string }).sql,
        ).not.toMatch(/from_state TEXT NOT NULL/);
        expect(after.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = '_substrat_refusals' ORDER BY name").all()).toEqual(indexesBefore);
        expect(after.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = '_substrat_refusals_new'").get()).toEqual({ n: 0 });
        const rows = after.prepare('SELECT * FROM _substrat_refusals ORDER BY id').all();
        if (wake === 1) {
          expect(rows).toEqual(before.map((r) => ({ ...(r as Record<string, unknown>), guard: null, reason: null })));
          // The rebuilt table admits a guard row: no from-state.
          after
            .prepare(
              `INSERT INTO _substrat_refusals (id, kind, tenant_id, scope_id, from_state, operation, guard, reason, actor, at)
               VALUES (?, 'guard', ?, ?, NULL, 'shop/finish', 'protocol/all-signed', 'protocol_required', ?, ?)`,
            )
            .run(ulid(), t, s, JSON.stringify(p), '2026-10-01T12:00:00.000Z');
          afterFirst = after.prepare('SELECT * FROM _substrat_refusals ORDER BY id').all();
          expect(afterFirst).toHaveLength(3);
        } else {
          expect(rows).toEqual(afterFirst);
        }
        after.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
