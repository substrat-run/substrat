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
 * live beside it. **Restore is the lever; a grant is not.** The marker is an ordinary
 * K-21 tuple: switching back on tombstones it, so the row stays as evidence of when the
 * switch was last pulled. The permission walk reads only `role:` and `granted:` relations
 * (`permission-eval.ts`), so the marker authorizes nothing and denies nothing by itself.
 *
 * Switching off ALSO tombstones every live `granted:` tuple the module holds on the scope.
 * That is what makes it a kill switch rather than a schedule pause: anything that acts
 * with the module's system authority — a resumable job run (#1577), a `getSystemScope`
 * invoke — is denied by its own `ctx.check` while the switch is off.
 *
 * **And nothing may write a new one while it is off**, which is what makes that denial
 * hold. The checker is deliberately NOT marker-aware; the switch is closed on the WRITE
 * side instead, at the only two writers of a scope-level `system:` grant:
 * - `grantToSystem` refuses while the module is switched off on that scope (the adapters
 *   ask `systemSwitchedOff` in the same unit as the write);
 * - provisioning's seat (`seatScopeTuple`) seats nothing for a subject whose marker is
 *   live, so a reconcile cannot create a grant a newer version declares.
 *
 * **Restore returns exactly what OFF took, never more.** Each grant OFF tombstones gets a
 * `switched:<permission>` record, live for as long as the switch holds it. ON restores
 * only grants with a live record, then tombstones the records — so a grant that was
 * revoked independently BEFORE the switch was pulled stays revoked through OFF and ON.
 *
 * Params and results are plain SQL over `_substrat_tuples`, run through `SwitchSql`,
 * which each adapter implements over its own handle inside one transaction.
 */

/** The relation of the OFF marker. Not `granted:` and not `role:`, so no check reads it. */
export const SYSTEM_SWITCH_OFF_RELATION = 'switch:off';

/** `switched:<permission>` — "the switch revoked this grant, and ON gives it back". */
const SWITCHED_PREFIX = 'switched:';

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
 * "Is this subject's OFF marker live?", as a SQL predicate over ONE bound parameter (the
 * subject). The one spelling the gate, the grant refusal and the provisioning seat share,
 * so the three cannot disagree about what "switched off" means.
 */
export const SYSTEM_SWITCH_OFF_PREDICATE = `EXISTS (SELECT 1 FROM _substrat_tuples
  WHERE subject = ? AND relation = '${SYSTEM_SWITCH_OFF_RELATION}' AND revoked_at IS NULL)`;

/**
 * The gate, one statement: is the OFF marker live, and is any `granted:` tuple live?
 * `substr` rather than `LIKE`: `LIKE` is case-insensitive in SQLite and a Durable
 * Object caps its patterns (#1655); an exact prefix compare is neither.
 */
export function systemScheduleState(db: SwitchSql, moduleId: string, now: string): SystemScheduleState {
  const subject = subjectOf(moduleId);
  const row = db.all(
    `SELECT
       ${SYSTEM_SWITCH_OFF_PREDICATE} AS off,
       EXISTS (SELECT 1 FROM _substrat_tuples
                WHERE subject = ? AND substr(relation, 1, 8) = 'granted:'
                  AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)) AS granted`,
    subject,
    subject,
    now,
  )[0] as { off: number; granted: number } | undefined;
  if (Number(row?.off) === 1) return 'off';
  return Number(row?.granted) === 1 ? 'on' : 'ungranted';
}

/** One module's position, as `systemGrantsStatus` below enumerates them. */
export interface SystemGrantsEntry {
  moduleId: string;
  schedules: SystemScheduleState;
}

/**
 * Every module this scope holds or has ever held system authority for, and where each
 * stands (#1674) — the per-scope status read (`GET .../system-grants`). One SELECT
 * enumerating the `system:<moduleId>` subjects this scope's storage has a live `granted:`
 * tuple or OFF marker for (a module with neither has never run here, and has nothing to
 * report — not even `ungranted`), then `systemScheduleState` per one: the SAME predicate
 * `runDueSchedules` gates on, so the read and the runner cannot disagree.
 */
export function systemGrantsStatus(db: SwitchSql, now: string): SystemGrantsEntry[] {
  const rows = db.all(
    `SELECT DISTINCT subject FROM _substrat_tuples
      WHERE substr(subject, 1, 7) = 'system:'
        AND (substr(relation, 1, 8) = 'granted:' OR relation = '${SYSTEM_SWITCH_OFF_RELATION}')
      ORDER BY subject`,
  ) as { subject: string }[];
  return rows.map((row) => {
    const moduleId = row.subject.slice('system:'.length);
    return { moduleId, schedules: systemScheduleState(db, moduleId, now) };
  });
}

/** Is this module switched off on the scope `db` is? What `grantToSystem` refuses on. */
export function systemSwitchedOff(db: SwitchSql, moduleId: string): boolean {
  const row = db.all(`SELECT ${SYSTEM_SWITCH_OFF_PREDICATE} AS off`, subjectOf(moduleId))[0] as
    | { off: number }
    | undefined;
  return Number(row?.off) === 1;
}

/** The refusal `grantToSystem` throws while the switch is off — one wording, both adapters. */
export function systemSwitchedOffMessage(moduleId: string, scopeId: string): string {
  return (
    `module '${moduleId}' is switched off on scope ${scopeId} (#1666) — restore it first ` +
    `(restoreToSystem). A grant is not the lever: granting while it is off would hand the ` +
    `module's system authority back to anything but its schedules.`
  );
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
 * OFF tombstones every live `granted:` tuple the module holds at `scope:<id>`, records each
 * as `switched:<permission>`, and makes the marker live. ON un-tombstones exactly the
 * grants with a live `switched:` record, tombstones those records, and tombstones the
 * marker. A repeated OFF re-asserts the whole position: a grant that became live meanwhile
 * (only a raw write can do that now) is tombstoned and recorded too.
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
    const live = grants.filter((g) => g.revoked_at === null).map((g) => permissionOf(g.relation));
    for (const permission of live) {
      db.run(
        `UPDATE _substrat_tuples SET revoked_at = ? WHERE subject = ? AND relation = ? AND object = ?`,
        input.at,
        subject,
        `granted:${permission}`,
        object,
      );
      // What ON may give back — and nothing else. INSERT OR REPLACE, so a record a past
      // OFF/ON cycle left tombstoned is live again for this one.
      db.run(
        `INSERT OR REPLACE INTO _substrat_tuples (subject, relation, object, expires_at, revoked_at)
         VALUES (?, ?, ?, NULL, NULL)`,
        subject,
        `${SWITCHED_PREFIX}${permission}`,
        object,
      );
    }
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
    return { held: true, changed: markerMoved || live.length > 0, permissions: live };
  }

  const records = db.all(
    `SELECT relation FROM _substrat_tuples
      WHERE subject = ? AND object = ? AND substr(relation, 1, 9) = ? AND revoked_at IS NULL
      ORDER BY relation`,
    subject,
    object,
    SWITCHED_PREFIX,
  ) as { relation: string }[];
  const restored: string[] = [];
  for (const { relation } of records) {
    const permission = relation.slice(SWITCHED_PREFIX.length);
    const revoked = grants.find((g) => g.relation === `granted:${permission}` && g.revoked_at !== null);
    if (revoked) {
      db.run(
        `UPDATE _substrat_tuples SET revoked_at = NULL WHERE subject = ? AND relation = ? AND object = ?`,
        subject,
        `granted:${permission}`,
        object,
      );
      restored.push(permission);
    }
    db.run(
      `UPDATE _substrat_tuples SET revoked_at = ? WHERE subject = ? AND relation = ? AND object = ?`,
      input.at,
      subject,
      relation,
      object,
    );
  }
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
  return { held: true, changed: markerMoved || restored.length > 0, permissions: restored };
}
