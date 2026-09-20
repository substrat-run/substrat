import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

/**
 * #1288's migration on the path production actually takes: a scope that already
 * exists, woken by code that now wants `kind` in the key. The shared contract suite
 * proves the same backfill through a RESTORE, which is the one legacy shape both
 * adapters can be handed; this is the one only the pure adapter can stage, because
 * only here can a test reach into the store and put the old table back.
 *
 * Three wakes, not one: the rebuild is create-copy-drop-rename and its detection is
 * a read of `sqlite_master.sql`, so "it ran" and "it ran once" are different facts —
 * a detection that missed would fail the second wake on `_substrat_schedule_state_new
 * already exists`, and one that half-ran would leave that table behind.
 */
describe('#1288: a pre-existing schedule-state table is rebuilt with kind, once', () => {
  it('backfills every row verbatim on the next wake, and is a no-op on the wakes after', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'substrat-schedule-kind-'));
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const p = principalId.parse(ulid());

    let host = new SqliteScopeHost({ dir });
    await host.admin.createTenant(staff, { id: t, slug: 'sched-kind', name: 'Sched kind' });
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'v' });
    await host.admin.activateScope(staff, t, s);
    await host.close();

    // Put the pre-#1288 table back, with one row of each family — the state a scope
    // provisioned before this release is holding when the new code first reaches it.
    const file = join(dir, `${t}__${s}.sqlite`);
    const db = new Database(file);
    db.exec('DROP TABLE _substrat_schedule_state');
    db.exec(
      'CREATE TABLE _substrat_schedule_state (schedule_op TEXT PRIMARY KEY, last_run_at TEXT, last_status TEXT)',
    );
    const insert = db.prepare('INSERT INTO _substrat_schedule_state VALUES (?, ?, ?)');
    insert.run('sched/tick', '2026-09-01T00:00:00.000Z', 'ok');
    insert.run('freshness:a.b', '2026-09-01T01:00:00.000Z', 'failed');
    db.close();

    for (let wake = 1; wake <= 3; wake += 1) {
      host = new SqliteScopeHost({ dir });
      // Opening a scope is what runs KERNEL_DDL and the spine pass behind it — no
      // sweep needed, and deliberately so: a scope migrates on contact, not on use.
      await host.getScope(p, t, s);
      await host.close();

      const after = new Database(file, { readonly: true });
      // Both keys verbatim, both recorded times and BOTH verdicts — the statuses
      // differ on purpose, so a backfill that dropped the rows and let the sweep
      // re-create them could not pass by writing 'ok' twice.
      expect(
        after
          .prepare(
            `SELECT kind, schedule_op, last_run_at, last_status FROM _substrat_schedule_state
              ORDER BY kind, schedule_op`,
          )
          .all(),
      ).toEqual([
        {
          kind: 'freshness',
          schedule_op: 'freshness:a.b',
          last_run_at: '2026-09-01T01:00:00.000Z',
          last_status: 'failed',
        },
        {
          kind: 'schedule',
          schedule_op: 'sched/tick',
          last_run_at: '2026-09-01T00:00:00.000Z',
          last_status: 'ok',
        },
      ]);
      // …and the scratch table the rebuild renames is gone, on every wake.
      expect(
        (
          after
            .prepare(`SELECT count(*) AS n FROM sqlite_master WHERE name LIKE '%\\_new' ESCAPE '\\'`)
            .get() as { n: number }
        ).n,
      ).toBe(0);
      after.close();
    }

    rmSync(dir, { recursive: true, force: true });
  });
});
