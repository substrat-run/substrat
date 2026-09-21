import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { moduleId, permissionKey, platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { scheduleMod } from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';

/**
 * #1659 on the pure adapter: `provisionScope` SEATS each module's `system:` schedule grant
 * (#383) with the kernel's `SEAT_SCOPE_TUPLE_SQL` — the statement the Cloudflare adapter
 * seats with — so a re-provision recreates a missing grant and leaves a revoked one
 * revoked. Revoking that grant is the per-scope schedule kill switch; it used to be
 * `INSERT OR REPLACE`, which turned the schedules back on at the next re-provision.
 *
 * `grantToSystem` is the explicit grant and still goes through `INSERT OR REPLACE`, so it is
 * the way back — a re-grant that kept the tombstone would be a silent no-op.
 *
 * The tombstone is written from a second connection to the scope file: no `HostAdmin` verb
 * revokes a `system:` grant today, so an operator's revoke is exactly that raw K-21 write.
 */
describe('#1659: a re-provision keeps a revoked schedule grant (pure adapter)', () => {
  it('leaves the revoke, recreates a missing grant, and `grantToSystem` grants again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'substrat-provision-seat-'));
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const SCHED = moduleId.parse('@test/sched');
    const REVOKED_AT = '2026-09-01T00:00:00.000Z';
    const file = join(dir, `${t}__${s}.sqlite`);
    const onScopeFile = <T>(fn: (db: Database.Database) => T): T => {
      const db = new Database(file);
      try {
        return fn(db);
      } finally {
        db.close();
      }
    };
    const row = (): { revoked_at: string | null; expires_at: string | null } | undefined =>
      onScopeFile(
        (db) =>
          db
            .prepare(
              `SELECT revoked_at, expires_at FROM _substrat_tuples
                WHERE subject = ? AND relation = 'granted:sched:tick' AND object = ?`,
            )
            .get(`system:${SCHED}`, `scope:${s}`) as { revoked_at: string | null; expires_at: string | null } | undefined,
      );

    const host = new SqliteScopeHost({ dir });
    host.registerModule(scheduleMod);
    const considered = async (): Promise<number> => {
      const report = await host.runDueSchedules(SCHED, t, s);
      expect(report.errors).toEqual([]);
      return report.fired + report.skipped;
    };
    const provision = () => host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'sched-vertical' });
    try {
      await host.admin.createTenant(staff, { id: t, slug: 'provision-seat', name: 'Provision seat' });
      await host.admin.grantEntitlement(staff, t, 'sched');
      await provision();
      await host.admin.activateScope(staff, t, s);
      expect(await considered()).toBeGreaterThan(0); // positive control: the grant is live

      // The operator's revoke: a tombstone, K-21's shape.
      onScopeFile((db) =>
        db
          .prepare(`UPDATE _substrat_tuples SET revoked_at = ? WHERE subject = ? AND relation = 'granted:sched:tick'`)
          .run(REVOKED_AT, `system:${SCHED}`),
      );
      expect(await considered()).toBe(0);

      await provision();
      expect(await considered()).toBe(0); // the kill switch survived the re-provision
      expect(row()).toEqual({ revoked_at: REVOKED_AT, expires_at: null }); // untouched

      // The explicit grant clears it — a re-grant grants.
      await host.admin.grantToSystem(staff, {
        moduleId: SCHED,
        permission: permissionKey.parse('sched:tick'),
        node: { tenantId: t, scopeId: s },
        grantedBy: staff,
      });
      expect(row()).toEqual({ revoked_at: null, expires_at: null });
      expect(await considered()).toBeGreaterThan(0);

      // A MISSING grant is not a revoke: a re-provision recreates it (#332's repair shape).
      onScopeFile((db) =>
        db.prepare(`DELETE FROM _substrat_tuples WHERE subject = ?`).run(`system:${SCHED}`),
      );
      expect(row()).toBeUndefined();
      expect(await considered()).toBe(0); // negative control: the delete really took it
      await provision();
      expect(row()).toEqual({ revoked_at: null, expires_at: null });
      expect(await considered()).toBeGreaterThan(0);
    } finally {
      await host.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
