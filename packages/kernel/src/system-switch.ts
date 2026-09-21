/**
 * The schedule kill switch (#1666), shared by both adapters so the gate that decides
 * whether a module's schedules run and the lever that moves it cannot disagree.
 *
 * A scope runs a module's schedules only while it holds a live `system:<module>` grant
 * (#383) — "the grant IS the switch". That sentence was true of the gate and had no
 * lever: nothing could revoke the grant. This file is the lever, and it has to be more
 * than a revoke, for two reasons found while building it:
 *
 * 1. **A reconcile seats grants.** Since #1659 a reconcile leaves a revoked grant revoked,
 *    but it still CREATES a missing one. A vertical whose next version declares a schedule
 *    with a new permission gets that grant seated live on every install — and a gate that
 *    reads "any live grant" is open again, on a scope an operator switched off.
 * 2. **An explicit grant clears a tombstone.** `grantToSystem` is `INSERT OR REPLACE` by
 *    design (#1659's re-grant guarantee), so a stray grant of one permission would bring
 *    that tuple back — and with it, under the old gate, the whole module.
 *
 * So the OFF position is a tuple of its own: a live `system:<module>` / `switch:off` /
 * `scope:<id>` marker. The gate is OFF while that marker is live, whatever grants are
 * live beside it — so neither a reconcile nor a grant can reopen it. **Restore is the
 * lever; a grant is not.** The marker is an ordinary K-21 tuple: switching back on
 * tombstones it, so the row stays as evidence of when the switch was last pulled. The
 * permission walk reads only `role:` and `granted:` relations (`permission-eval.ts`), so
 * the marker authorizes nothing and denies nothing by itself.
 *
 * Switching off ALSO tombstones every live `granted:` tuple the module holds on the scope.
 * That is what makes it a kill switch rather than a schedule pause: anything that acts
 * with the module's system authority — a resumable job run (#1577) included — is denied
 * by its own `ctx.check` while the switch is off. Switching on restores exactly those.
 *
 * Params and results are plain SQL over `_substrat_tuples`, run through `SwitchSql`,
 * which each adapter implements over its own handle inside one transaction.
 */

/** The relation of the OFF marker. Not `granted:` and not `role:`, so no check reads it. */
export const SYSTEM_SWITCH_OFF_RELATION = 'switch:off';

/** The two statement shapes the switch needs, over either adapter's SQLite handle. */
export interface SwitchSql {
  all(sql: string, ...params: (string | null)[]): Record<string, unknown>[];
  run(sql: string, ...params: (string | null)[]): void;
}

/**
 * Where one module's schedules stand on one scope.
 *
 * - `on`: a live grant and no live OFF marker — due schedules fire.
 * - `off`: a live OFF marker. The schedules do not fire, and each is reported `skipped`
 *   with `switchedOff: true` — the sweep reached the scope and chose not to run, which
 *   is not the same fact as a sweep that never reached it.
 * - `ungranted`: no live grant and no marker. A foreign vertical's scope on a CP-full host
 *   (the module is registered and this scope never ran it), or a grant removed by a raw
 *   write. Quiet, exactly as before the switch existed: no run, no skip, no error.
 */
export type SystemScheduleState = 'on' | 'off' | 'ungranted';

const subjectOf = (moduleId: string): string => `system:${moduleId}`;

/**
 * The gate, one statement: is the OFF marker live, and is any `granted:` tuple live?
 * `substr` rather than `LIKE`: `LIKE` is case-insensitive in SQLite and a Durable
 * Object caps its patterns (#1655); an exact prefix compare is neither.
 */
export function systemScheduleState(db: SwitchSql, moduleId: string, now: string): SystemScheduleState {
  const subject = subjectOf(moduleId);
  const row = db.all(
    `SELECT
       EXISTS (SELECT 1 FROM _substrat_tuples
                WHERE subject = ? AND relation = ? AND revoked_at IS NULL) AS off,
       EXISTS (SELECT 1 FROM _substrat_tuples
                WHERE subject = ? AND substr(relation, 1, 8) = 'granted:'
                  AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)) AS granted`,
    subject,
    SYSTEM_SWITCH_OFF_RELATION,
    subject,
    now,
  )[0] as { off: number; granted: number } | undefined;
  if (Number(row?.off) === 1) return 'off';
  return Number(row?.granted) === 1 ? 'on' : 'ungranted';
}

/** What one switch call did in the scope's own storage — `SystemSwitchOutcome`'s shape. */
export interface SwitchOutcome {
  held: boolean;
  changed: boolean;
  permissions: string[];
}

/**
 * Move one module's switch on one scope. Idempotent: a repeat changes nothing and says so.
 *
 * OFF tombstones every live `granted:` tuple the module holds at `scope:<id>` and makes
 * the marker live. ON clears every tombstone among those tuples and tombstones the marker.
 * A repeated OFF after something re-granted a tuple (a reconcile seating a new
 * permission, a stray `grantToSystem`) tombstones that tuple too — the switch re-asserts
 * the whole position, not only the marker.
 *
 * `held: false`, with nothing written, when the scope holds neither a grant nor a marker
 * for the module: the caller named something this scope never ran, and turning "nothing"
 * off must not write a marker that silently disables a module the day it is installed.
 *
 * Run it inside one transaction; the reads and writes here are meant to be one unit.
 */
export function switchSystemSchedules(
  db: SwitchSql,
  input: { moduleId: string; scopeId: string; to: 'on' | 'off'; at: string },
): SwitchOutcome {
  const subject = subjectOf(input.moduleId);
  const object = `scope:${input.scopeId}`;
  const grants = db.all(
    `SELECT relation, revoked_at FROM _substrat_tuples
      WHERE subject = ? AND object = ? AND substr(relation, 1, 8) = 'granted:'
      ORDER BY relation`,
    subject,
    object,
  ) as { relation: string; revoked_at: string | null }[];
  const marker = db.all(
    `SELECT revoked_at FROM _substrat_tuples WHERE subject = ? AND relation = ? AND object = ?`,
    subject,
    SYSTEM_SWITCH_OFF_RELATION,
    object,
  )[0] as { revoked_at: string | null } | undefined;
  if (grants.length === 0 && !marker) return { held: false, changed: false, permissions: [] };

  const permissionOf = (relation: string): string => relation.slice('granted:'.length);
  if (input.to === 'off') {
    const live = grants.filter((g) => g.revoked_at === null).map((g) => g.relation);
    db.run(
      `UPDATE _substrat_tuples SET revoked_at = ?
        WHERE subject = ? AND object = ? AND substr(relation, 1, 8) = 'granted:' AND revoked_at IS NULL`,
      input.at,
      subject,
      object,
    );
    const markerMoved = !marker || marker.revoked_at !== null;
    if (markerMoved) {
      db.run(
        `INSERT OR REPLACE INTO _substrat_tuples (subject, relation, object, expires_at, revoked_at)
         VALUES (?, ?, ?, NULL, NULL)`,
        subject,
        SYSTEM_SWITCH_OFF_RELATION,
        object,
      );
    }
    return { held: true, changed: markerMoved || live.length > 0, permissions: live.map(permissionOf) };
  }

  const revoked = grants.filter((g) => g.revoked_at !== null).map((g) => g.relation);
  db.run(
    `UPDATE _substrat_tuples SET revoked_at = NULL
      WHERE subject = ? AND object = ? AND substr(relation, 1, 8) = 'granted:' AND revoked_at IS NOT NULL`,
    subject,
    object,
  );
  const markerMoved = marker !== undefined && marker.revoked_at === null;
  if (markerMoved) {
    db.run(
      `UPDATE _substrat_tuples SET revoked_at = ? WHERE subject = ? AND relation = ? AND object = ?`,
      input.at,
      subject,
      SYSTEM_SWITCH_OFF_RELATION,
      object,
    );
  }
  return { held: true, changed: markerMoved || revoked.length > 0, permissions: revoked.map(permissionOf) };
}
