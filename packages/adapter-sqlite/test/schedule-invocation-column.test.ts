import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

/**
 * #1525's ALTER, distinct from #1288's REBUILD in `schedule-state-kind.test.ts`
 * (same file layout, same "reach into the store" technique, a different column):
 * this table already has `kind` in its key — the shape every scope past #1288
 * holds — and is only missing `invocation_id`, because it predates THIS column.
 * `ensureColumn` is idempotent by construction (a `PRAGMA table_info` check before
 * ever issuing the ALTER, not a try/catch on a thrown duplicate the way the DO's
 * array of raw statements is), so proving it tolerates repeated wakes is proving
 * the check runs every time rather than being skipped after the first.
 *
 * Three wakes, not one, for the same reason #1288's test uses three: "it ran" and
 * "it ran once, correctly, and stayed a no-op after" are different facts.
 */
describe('#1525: a pre-existing schedule-state table gets invocation_id ALTERed in', () => {
  it('adds the column on the next wake, leaves the old row honestly unattributed, and is a no-op on the wakes after', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'substrat-schedule-invid-'));
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const p = principalId.parse(ulid());

    let host = new SqliteScopeHost({ dir });
    await host.admin.createTenant(staff, { id: t, slug: 'sched-invid', name: 'Sched invid' });
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'v' });
    await host.admin.activateScope(staff, t, s);
    await host.close();

    // Put the shape #1288 left and #1525 replaced back: `kind` already in the key,
    // no `invocation_id` column at all — exactly what a scope provisioned between
    // those two releases is holding when this code first reaches it.
    const file = join(dir, `${t}__${s}.sqlite`);
    const db = new Database(file);
    db.exec('DROP TABLE _substrat_schedule_state');
    db.exec(
      'CREATE TABLE _substrat_schedule_state (kind TEXT NOT NULL, schedule_op TEXT NOT NULL, ' +
        'last_run_at TEXT, last_status TEXT, PRIMARY KEY (kind, schedule_op))',
    );
    db.prepare('INSERT INTO _substrat_schedule_state VALUES (?, ?, ?, ?)').run(
      'schedule',
      'sched/tick',
      '2026-09-01T00:00:00.000Z',
      'ok',
    );
    db.close();

    for (let wake = 1; wake <= 3; wake += 1) {
      host = new SqliteScopeHost({ dir });
      // Opening a scope is what runs `ensureSpineColumns` — no sweep needed, a
      // scope migrates on contact, not on use (the same property #1288's test pins).
      await host.getScope(p, t, s);
      await host.close();

      const after = new Database(file, { readonly: true });
      const columns = (after.prepare('PRAGMA table_info(_substrat_schedule_state)').all() as { name: string }[]).map(
        (c) => c.name,
      );
      expect(columns).toContain('invocation_id');
      // #2096's column, missing from the same table, arrives the same way: NULL — the start of a
      // purge lap — for the row already there.
      expect(columns).toContain('purge_cursor');
      expect(after.prepare('SELECT purge_cursor FROM _substrat_schedule_state').all()).toEqual([{ purge_cursor: null }]);
      // The row survives every wake verbatim, `invocation_id` included: null is the
      // honest fact that no call was carried for a row this old, on every wake, not
      // just the first.
      expect(
        after
          .prepare(
            `SELECT kind, schedule_op, last_run_at, last_status, invocation_id
               FROM _substrat_schedule_state`,
          )
          .all(),
      ).toEqual([
        {
          kind: 'schedule',
          schedule_op: 'sched/tick',
          last_run_at: '2026-09-01T00:00:00.000Z',
          last_status: 'ok',
          invocation_id: null,
        },
      ]);
      after.close();
    }

    rmSync(dir, { recursive: true, force: true });
  });
});
