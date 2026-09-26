/**
 * The directory's record of the schedule kill switch (#1674), shared by both adapters.
 *
 * The switch itself (`system-switch.ts`) lives in the scope's own storage: a `switch:off`
 * marker beside the module's grants, which is what the runner gates on. That is the right
 * place for the gate, and the wrong place for the only copy. A scope whose storage is wiped
 * and re-provisioned (#321/#332), or restored from a dump taken before the switch was pulled,
 * loses the marker, and the next reconcile seats the grants live again. The switch is then
 * silently on, on exactly the scopes an operator switched off.
 *
 * So the directory keeps one row per (tenant, scope, module): the position the switch was
 * last moved to, by whom, why, and when. It is the model `_substrat_connection_grants` set
 * (#592): the enforcement stays where it is checked, and the directory holds what a
 * reconcile re-asserts FROM. It also answers the fleet question the scope cannot: "which
 * scopes have a module switched off", without walking every scope's store.
 *
 * **OFF wins from either side, and a record never turns anything on.**
 * - A record of `off` and a scope that has lost its marker: the record wins, and
 *   `HostAdmin.reassertSystemSwitches` switches it off again, after the seat, so the grants
 *   the seat recreated are the ones OFF tombstones and a later ON gives back.
 * - A record of `on` (or none) and a live marker: the marker wins, and it stays off.
 *   Restore is the lever (#1666), and a reconcile that could turn a kill switch back on
 *   would be a second one.
 *
 * The admin log is still the history. This is only the current position.
 */
import type { ListPage } from '@substrat-run/contracts';
import type { SwitchSql, SwitchedOff, SystemScheduleState } from './system-switch.js';

/**
 * The table. Interpolated into both adapters' directory DDL, so `lint:spine-ddl` sees the
 * one spelling on each side. No CHECK on `position`: the drift gate does not compare
 * constraints, and the writers below are the only thing that sets it.
 */
export const SYSTEM_SWITCHES_DDL = `
  CREATE TABLE IF NOT EXISTS _substrat_system_switches (
    tenant_id    TEXT NOT NULL,
    scope_id     TEXT NOT NULL,
    module_id    TEXT NOT NULL,
    -- 'on' or 'off'. A row exists only for a module some switch call actually held.
    position     TEXT NOT NULL,
    actor        TEXT NOT NULL,
    reason       TEXT NOT NULL,
    -- The switch call's own id, the one its admin-log intent and outcome rows carry.
    -- A ULID, so it is also the fleet read's chronological keyset cursor.
    operation_id TEXT NOT NULL,
    switched_at  TEXT NOT NULL,
    PRIMARY KEY (tenant_id, scope_id, module_id)
  );
  CREATE INDEX IF NOT EXISTS _substrat_system_switches_position
    ON _substrat_system_switches (position, operation_id);
  CREATE INDEX IF NOT EXISTS _substrat_system_switches_operation
    ON _substrat_system_switches (operation_id);
`;

/**
 * The one-time backfill from the admin log: every switch moved before the record existed.
 * Without it, those are exactly the switches a wipe would still lose.
 *
 * It reads the admin-log shape `revokeFromSystem` / `restoreToSystem` have written since
 * #1666, two rows per call sharing `after.operationId`: an `intent` row carrying
 * `after.moduleId` and `after.reason`, then an outcome row whose `after.phase` is
 * `applied`, `refused` or `failed`. Only calls whose outcome is `applied` count, because a
 * refused call moved nothing and a failed one may not have. Of those, only the LATEST per
 * (tenant, scope, module) is taken, by the intent's ULID id. `at` is the intent's, the
 * same instant the status read's who/why join reports. A key whose calls include no
 * applied OFF gets no row, even when its latest applied call is an ON: a live
 * `restoreToSystem` of a module never switched off writes none either
 * (`recordSystemSwitchedOn`), and the backfill must not record what the live path would not.
 *
 * `INSERT OR IGNORE`, so a row the switch wrote itself is never overwritten by history.
 * The adapters run it only on the construction that creates the table, so it runs once.
 */
export const SYSTEM_SWITCHES_BACKFILL_SQL = `
  WITH applied AS (
    SELECT DISTINCT action, json_extract(after, '$.operationId') AS operation_id
      FROM _substrat_admin_log
     WHERE action IN ('revokeFromSystem', 'restoreToSystem')
       AND json_extract(after, '$.phase') = 'applied'
  ),
  intents AS (
    SELECT i.id AS id, i.tenant_id AS tenant_id, i.scope_id AS scope_id,
           json_extract(i.after, '$.moduleId') AS module_id,
           CASE i.action WHEN 'revokeFromSystem' THEN 'off' ELSE 'on' END AS position,
           i.actor AS actor,
           json_extract(i.after, '$.reason') AS reason,
           json_extract(i.after, '$.operationId') AS operation_id,
           i.at AS at
      FROM _substrat_admin_log i
      JOIN applied a
        ON a.action = i.action AND a.operation_id = json_extract(i.after, '$.operationId')
     WHERE i.action IN ('revokeFromSystem', 'restoreToSystem')
       AND i.tenant_id IS NOT NULL AND i.scope_id IS NOT NULL
       AND json_extract(i.after, '$.phase') = 'intent'
       AND json_extract(i.after, '$.moduleId') IS NOT NULL
       AND json_extract(i.after, '$.reason') IS NOT NULL
  ),
  ranked AS (
    SELECT *,
           ROW_NUMBER() OVER (PARTITION BY tenant_id, scope_id, module_id ORDER BY id DESC) AS latest,
           MAX(position = 'off') OVER (PARTITION BY tenant_id, scope_id, module_id) AS ever_off
      FROM intents
  )
  INSERT OR IGNORE INTO _substrat_system_switches
    (tenant_id, scope_id, module_id, position, actor, reason, operation_id, switched_at)
  SELECT tenant_id, scope_id, module_id, position, actor, reason, operation_id, at
    FROM ranked
   WHERE latest = 1 AND ever_off = 1
`;

/** "Does the record table exist yet?" — asked BEFORE the DDL, so the backfill runs once. */
export function systemSwitchesTableExists(db: SwitchSql): boolean {
  return (
    db.all(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = '_substrat_system_switches'`)
      .length > 0
  );
}

/** One record row as the directory holds it, with the scope's binding joined on. */
export interface SystemSwitchRecordRow {
  tenantId: string;
  scopeId: string;
  moduleId: string;
  vertical: string | null;
  position: 'on' | 'off';
  actor: string;
  reason: string;
  operationId: string;
  at: string;
}

/**
 * Filter for the fleet read. Unset `position` means both; the HTTP route defaults it to
 * `off`. Paged by `operationId` (the exclusive cursor), oldest first unless `order: 'desc'`.
 */
export interface SystemSwitchRecordFilter extends ListPage {
  position?: 'on' | 'off';
  tenantId?: string;
  scopeId?: string;
  moduleId?: string;
  vertical?: string;
}

const positionOf = (v: unknown): 'on' | 'off' => (v === 'on' ? 'on' : 'off');

const COLUMNS = `r.tenant_id, r.scope_id, r.module_id, s.vertical, r.position, r.actor, r.reason,
  r.operation_id, r.switched_at`;

const rowOf = (r: Record<string, unknown>): SystemSwitchRecordRow => ({
  tenantId: String(r.tenant_id),
  scopeId: String(r.scope_id),
  moduleId: String(r.module_id),
  vertical: r.vertical == null ? null : String(r.vertical),
  position: positionOf(r.position),
  actor: String(r.actor),
  reason: String(r.reason),
  operationId: String(r.operation_id),
  at: String(r.switched_at),
});

/**
 * The fleet read (`GET /system-switches`): records, keyset-paged by `operation_id`.
 *
 * The key is the call that last moved the switch, so a row whose switch moves during a walk
 * is re-keyed to a newer id and jumps to the end of the order. Ascending (the default) never
 * skips a row for it; at worst it is seen twice, once per position. A DESCENDING walk can
 * miss a row that moved after the walk started, so use ascending for "every switch".
 */
export function listSystemSwitchRecords(db: SwitchSql, filter: SystemSwitchRecordFilter = {}): SystemSwitchRecordRow[] {
  const where: string[] = [];
  const params: string[] = [];
  const eq = (col: string, v: string | undefined) => {
    if (v !== undefined) {
      where.push(`${col} = ?`);
      params.push(v);
    }
  };
  eq('r.position', filter.position);
  eq('r.tenant_id', filter.tenantId);
  eq('r.scope_id', filter.scopeId);
  eq('r.module_id', filter.moduleId);
  eq('s.vertical', filter.vertical);
  const order = filter.order === 'desc' ? 'DESC' : 'ASC';
  if (filter.cursor !== undefined) {
    where.push(order === 'DESC' ? 'r.operation_id < ?' : 'r.operation_id > ?');
    params.push(filter.cursor);
  }
  // LEFT JOIN: a record outlives nothing it needs from `scopes`, and a scope row the
  // directory lost must not hide a switch that is still off in the scope's store.
  let sql =
    `SELECT ${COLUMNS} FROM _substrat_system_switches r LEFT JOIN scopes s ON s.scope_id = r.scope_id` +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ` ORDER BY r.operation_id ${order}`;
  if (filter.limit !== undefined) {
    sql += ` LIMIT ${Math.max(0, Math.floor(filter.limit))}`;
  }
  return db.all(sql, ...params).map(rowOf);
}

/** One scope's record rows by module — what the per-scope status read joins as `recorded`. */
export function systemSwitchRecordsOf(
  db: SwitchSql,
  tenantId: string,
  scopeId: string,
): Map<string, 'on' | 'off'> {
  const rows = db.all(
    `SELECT module_id, position FROM _substrat_system_switches WHERE tenant_id = ? AND scope_id = ?`,
    tenantId,
    scopeId,
  );
  return new Map(rows.map((r) => [String(r.module_id), positionOf(r.position)]));
}

/**
 * The per-scope status read's rows with the record joined on. Each module the scope
 * reports gets its recorded position (or null). A module the record holds that the scope
 * no longer reports at all is ADDED, as `ungranted`: that is the scope a wipe emptied, and
 * the drift is the whole reason to show it. Sorted by module id, as the scope's rows are.
 */
export function withRecorded(
  states: { moduleId: string; schedules: SystemScheduleState }[],
  recorded: Map<string, 'on' | 'off'>,
): { moduleId: string; schedules: SystemScheduleState; recorded: 'on' | 'off' | null }[] {
  const rows = states.map((s) => ({ ...s, recorded: recorded.get(s.moduleId) ?? null }));
  const reported = new Set(states.map((s) => s.moduleId));
  for (const [moduleId, position] of recorded) {
    if (!reported.has(moduleId)) rows.push({ moduleId, schedules: 'ungranted', recorded: position });
  }
  return rows.sort((a, b) => (a.moduleId < b.moduleId ? -1 : a.moduleId > b.moduleId ? 1 : 0));
}

/** The modules a reconcile must re-assert OFF on this scope. */
export function switchedOffModulesOf(db: SwitchSql, tenantId: string, scopeId: string): string[] {
  return db
    .all(
      `SELECT module_id FROM _substrat_system_switches
        WHERE tenant_id = ? AND scope_id = ? AND position = 'off' ORDER BY module_id`,
      tenantId,
      scopeId,
    )
    .map((r) => String(r.module_id));
}

/** What one switch call writes into the record. */
export interface SystemSwitchRecordWrite {
  tenantId: string;
  scopeId: string;
  moduleId: string;
  actor: string;
  reason: string;
  operationId: string;
  at: string;
}

/** The row as it stood before a write, so a failed switch can put it back. */
export type SystemSwitchRecordPrior = Pick<
  SystemSwitchRecordRow,
  'position' | 'actor' | 'reason' | 'operationId' | 'at'
> | null;

/** What a re-assert did for one recorded-off module — `HostAdmin.reassertSystemSwitches`' answer. */
export interface SystemSwitchReassert {
  moduleId: string;
  held: boolean;
  changed: boolean;
}

/**
 * What the deployment reports it switched off inside the reconcile's own unit (#1742), passed
 * to `HostAdmin.reassertSystemSwitches` so the move is audited here. The re-assert that
 * follows finds those modules already off (`changed: false`), and without this the admin log
 * would stop showing that a wiped scope was put back off.
 */
export interface SystemSwitchReassertOptions {
  appliedInUnit?: readonly Pick<SwitchedOff, 'moduleId' | 'changed' | 'permissions'>[];
}

/**
 * The `reassertSystemSwitch` audit rows (less their `operationId`) for the in-unit moves:
 * those that changed something, on a module the directory records `off` for this scope.
 * That filter is the point. The report comes from the deployment, and an audit row naming
 * a module the record never switched off would be the deployment writing the platform's
 * log. One row per module, first report wins. Built here so both adapters write one shape.
 */
export function inUnitMovesToAudit(
  recordedOff: readonly string[],
  applied: SystemSwitchReassertOptions['appliedInUnit'],
): {
  moduleId: string;
  schedules: 'off';
  phase: 'applied';
  changed: true;
  permissions: string[];
  inUnit: true;
}[] {
  const off = new Set(recordedOff);
  const moves = new Map<string, string[]>();
  for (const a of applied ?? []) {
    if (a.changed && off.has(a.moduleId) && !moves.has(a.moduleId)) moves.set(a.moduleId, [...a.permissions]);
  }
  return [...moves].map(([moduleId, permissions]) => ({
    moduleId,
    schedules: 'off',
    phase: 'applied',
    changed: true,
    permissions,
    inUnit: true,
  }));
}

/**
 * Overwrite one existing row's position and provenance — ON's write, and its undo. With
 * `ifOperationId`, only while the row is still the one that operation wrote (a CAS).
 */
function setRecordRow(
  db: SwitchSql,
  key: { tenantId: string; scopeId: string; moduleId: string },
  row: NonNullable<SystemSwitchRecordPrior>,
  ifOperationId?: string,
): void {
  db.run(
    `UPDATE _substrat_system_switches
        SET position = ?, actor = ?, reason = ?, operation_id = ?, switched_at = ?
      WHERE tenant_id = ? AND scope_id = ? AND module_id = ?` +
      (ifOperationId === undefined ? '' : ' AND operation_id = ?'),
    row.position,
    row.actor,
    row.reason,
    row.operationId,
    row.at,
    key.tenantId,
    key.scopeId,
    key.moduleId,
    ...(ifOperationId === undefined ? [] : [ifOperationId]),
  );
}

/**
 * OFF's write, made AFTER the scope's switch held. An upsert: a repeat OFF refreshes the
 * actor, reason and time, as the status read reports the latest reason. Never made for a
 * call that held nothing, because a row saying `off` for a module the scope never ran
 * would switch it off on the day it is installed (the kernel's `held` check, for the same
 * reason).
 */
export function recordSystemSwitchedOff(db: SwitchSql, row: SystemSwitchRecordWrite): void {
  db.run(
    `INSERT INTO _substrat_system_switches
       (tenant_id, scope_id, module_id, position, actor, reason, operation_id, switched_at)
     VALUES (?, ?, ?, 'off', ?, ?, ?, ?)
     ON CONFLICT (tenant_id, scope_id, module_id) DO UPDATE SET
       position = 'off', actor = excluded.actor, reason = excluded.reason,
       operation_id = excluded.operation_id, switched_at = excluded.switched_at`,
    row.tenantId,
    row.scopeId,
    row.moduleId,
    row.actor,
    row.reason,
    row.operationId,
    row.at,
  );
}

/**
 * ON's write, made BEFORE the scope's switch moves, and only to a row that exists. Before,
 * because the other order fails unsafely: a scope switched on whose record write then
 * failed would still read `off`, and the next reconcile would switch the operator's
 * restore back off. This order fails toward a record of `on` beside a live marker, which
 * the marker wins. Answers the row as it was, for `restoreSystemSwitchRecord`.
 */
export function recordSystemSwitchedOn(db: SwitchSql, row: SystemSwitchRecordWrite): SystemSwitchRecordPrior {
  const prior = db.all(
    `SELECT position, actor, reason, operation_id, switched_at FROM _substrat_system_switches
      WHERE tenant_id = ? AND scope_id = ? AND module_id = ?`,
    row.tenantId,
    row.scopeId,
    row.moduleId,
  )[0];
  if (!prior) return null;
  setRecordRow(db, row, { position: 'on', actor: row.actor, reason: row.reason, operationId: row.operationId, at: row.at });
  return {
    position: positionOf(prior.position),
    actor: String(prior.actor),
    reason: String(prior.reason),
    operationId: String(prior.operation_id),
    at: String(prior.switched_at),
  };
}

/**
 * Put a row back as `recordSystemSwitchedOn` found it — the ON that wrote it threw, or held
 * nothing. A compare-and-set on the ON's own `operationId`: if another switch call has
 * written the row since (a concurrent OFF), the row is left as that call wrote it, so an
 * ON's undo can never clobber a newer position.
 */
export function restoreSystemSwitchRecord(
  db: SwitchSql,
  on: { tenantId: string; scopeId: string; moduleId: string; operationId: string },
  prior: SystemSwitchRecordPrior,
): void {
  if (prior) setRecordRow(db, on, prior, on.operationId);
}

/**
 * Forget one scope's switch records — the scope's directory row is going too (a reaped
 * preview or fork, a reaped scope). Without this the fleet read keeps listing a switch on
 * a scope that no longer exists. The admin log keeps the history, as it keeps the scope's.
 */
export function forgetSystemSwitchesOf(db: SwitchSql, scopeId: string): void {
  db.run(`DELETE FROM _substrat_system_switches WHERE scope_id = ?`, scopeId);
}
