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
 *
 * **The record and the scope follow the same call** (#2045). A switch call writes this record, then
 * moves the scope, and nothing makes the pair one unit, so two calls on one subject could interleave
 * and leave the two on different positions. Each row holds the operation id of the call that wrote
 * it, and a write from an older call writes nothing (`recordWriteSuperseded`). The scope refuses an
 * older move the same way (`SWITCH_FENCES_DDL`), and re-asserts move under the row's id
 * (`switchFencesOf`). Both sides therefore settle on the newest call's position.
 *
 * **Two kinds of switch, one record path** (#2029). The peer kill switch (#1706,
 * `revokeFromPeer`) moves the same marker for a `vertical:<slug>` subject, and loses it the
 * same ways: a wipe, a restore, a PITR rewind. So it is recorded the same way, in its own
 * table (`_substrat_peer_switches`, keyed by the calling vertical's slug), by the same
 * functions below, each told which `SwitchKind` it is writing. Its own table, not rows in the
 * module table: that table's key is (tenant, scope, module id), and a vertical slug can be
 * spelled exactly like a module id.
 */
import type { ListPage } from '@substrat-run/contracts';
import { liveTupleSql } from './permission-eval.js';
import {
  PEER_SUBJECT_PREFIX,
  type SwitchKind,
  type SwitchSql,
  type SwitchedOff,
  type SystemScheduleState,
} from './system-switch.js';

export type { SwitchKind };

/** The record's table name, as the DDL below spells it. */
const SYSTEM_SWITCHES_TABLE = '_substrat_system_switches';
/** The peer switch's record (#2029), as `PEER_SWITCHES_DDL` spells it. */
const PEER_SWITCHES_TABLE = '_substrat_peer_switches';

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
 * The peer switch's record (#2029): `SYSTEM_SWITCHES_DDL`'s shape, keyed by the calling
 * vertical's slug. No fleet read pages it yet, so it carries none of that read's indexes; every
 * read here names (tenant, scope), the primary key's prefix.
 */
export const PEER_SWITCHES_DDL = `
  CREATE TABLE IF NOT EXISTS _substrat_peer_switches (
    tenant_id    TEXT NOT NULL,
    scope_id     TEXT NOT NULL,
    -- The calling vertical's slug, as the target's peers declaration names it.
    vertical     TEXT NOT NULL,
    position     TEXT NOT NULL,
    actor        TEXT NOT NULL,
    reason       TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    switched_at  TEXT NOT NULL,
    PRIMARY KEY (tenant_id, scope_id, vertical)
  );
`;

/**
 * Everything that differs between the two kinds, in one place: where each is recorded, how its
 * switch calls and re-asserts are written to the admin log, and how a call that held nothing is
 * refused. Every function below reads this table; none branches on the kind itself.
 */
const RECORDS = {
  system: {
    table: SYSTEM_SWITCHES_TABLE,
    ddl: SYSTEM_SWITCHES_DDL,
    key: 'module_id',
    subjectPrefix: 'system:',
    actions: ['revokeFromSystem', 'restoreToSystem'],
    reassertAction: 'reassertSystemSwitch',
    /** The payload fields naming the subject and its position (`moduleId` + `schedules`). */
    payloadKey: 'moduleId',
    positionField: 'schedules',
    notFound: (scopeId: string, key: string, to: string) =>
      `scope ${scopeId} holds no system grant for module '${key}' — nothing to switch ${to} ` +
      `(check the module id: it is the module's manifest id, e.g. '@substrat-run/engine-absence')`,
  },
  peer: {
    table: PEER_SWITCHES_TABLE,
    ddl: PEER_SWITCHES_DDL,
    key: 'vertical',
    subjectPrefix: PEER_SUBJECT_PREFIX,
    actions: ['revokeFromPeer', 'restoreToPeer'],
    reassertAction: 'reassertPeerSwitch',
    payloadKey: 'vertical',
    positionField: 'calls',
    notFound: (scopeId: string, key: string, to: string) =>
      `scope ${scopeId} holds no grant for peer '${key}' — nothing to switch ${to} ` +
      `(check the slug: it is the calling vertical's registry id, as the target's \`peers\` names it)`,
  },
} as const;

/** Every admin-log action a switch CALL writes its intent and outcome under (#2089: the settle closes them). */
export const SWITCH_ACTIONS = [...RECORDS.system.actions, ...RECORDS.peer.actions] as const;
export type SwitchAction = (typeof SWITCH_ACTIONS)[number];

/** Every kind, for the passes that walk them all (a scope's reap, a directory restore). */
export const SWITCH_KINDS: readonly SwitchKind[] = ['system', 'peer'];

/** The admin-log action a switch call of this kind writes its intent and outcome rows under. */
export const switchActionOf = (kind: SwitchKind, to: 'on' | 'off'): (typeof RECORDS)[SwitchKind]['actions'][number] =>
  RECORDS[kind].actions[to === 'off' ? 0 : 1];

/** The `not_found` a switch call that held nothing answers — one wording per kind, both adapters. */
export const switchNotFoundMessage = (kind: SwitchKind, scopeId: string, key: string, to: 'on' | 'off'): string =>
  RECORDS[kind].notFound(scopeId, key, to);

/**
 * #2045: the `conflict` a switch call answers when a newer call on the same subject got there first —
 * its record write or its move was refused by the fence, and nothing of it was written.
 */
export const switchSupersededMessage = (kind: SwitchKind, scopeId: string, key: string, to: 'on' | 'off'): string =>
  `a newer switch call on ${kind === 'system' ? `module '${key}'` : `peer '${key}'`} on scope ${scopeId} landed first, ` +
  `so this one (${to}) switched nothing. Read the scope's switch status before retrying.`;

/** The record table of one kind. */
export const switchesTableOf = (kind: SwitchKind): string => RECORDS[kind].table;

/**
 * #2045: the subjects whose scope may not be where their record says. A WRITE-AHEAD intent
 * (Codex r3): the switch call's record write marks its subject owed in the same directory write,
 * BEFORE anything moves, and the mark is cleared only once the scope has confirmed a move under a
 * fence at least the call's own (`clearSwitchOwed`). So every way a move can go wrong — it throws,
 * its answer is lost, the RPC that would have cleared the mark fails, the caller dies — leaves the
 * mark set, and the next re-assert moves the scope to its record, in EITHER direction, under the
 * record's fence. Without a mark a re-assert keeps #1674's rule: a record never turns anything on.
 *
 * `operation_id` is the newest call that marked the subject. A confirmation under an older fence
 * clears nothing, so a newer call's mark outlives an older call's success.
 */
export const SWITCH_OWED_DDL = `
  CREATE TABLE IF NOT EXISTS _substrat_switch_owed (
    tenant_id    TEXT NOT NULL,
    scope_id     TEXT NOT NULL,
    -- 'system' or 'peer', and the module id or the peer's slug.
    kind         TEXT NOT NULL,
    subject      TEXT NOT NULL,
    -- The newest switch call that marked it: a ULID, so it orders by text.
    operation_id TEXT NOT NULL,
    PRIMARY KEY (tenant_id, scope_id, kind, subject)
  );
`;

/** #2045: mark one subject's scope owed a re-assert, by this switch call. Never moves a mark backwards. */
export function markSwitchOwed(
  db: SwitchSql,
  kind: SwitchKind,
  tenantId: string,
  scopeId: string,
  key: string,
  operationId: string,
): void {
  db.run(
    `INSERT INTO _substrat_switch_owed (tenant_id, scope_id, kind, subject, operation_id) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, scope_id, kind, subject) DO UPDATE SET operation_id = excluded.operation_id
      WHERE excluded.operation_id > _substrat_switch_owed.operation_id`,
    tenantId,
    scopeId,
    kind,
    key,
    operationId,
  );
}

/** #2045: the subjects of one kind marked owed on one scope, each with the newest call that marked it. */
export function switchesOwedOf(db: SwitchSql, kind: SwitchKind, tenantId: string, scopeId: string): Map<string, string> {
  const rows = db.all(
    `SELECT subject, operation_id FROM _substrat_switch_owed
      WHERE tenant_id = ? AND scope_id = ? AND kind = ? ORDER BY subject`,
    tenantId,
    scopeId,
    kind,
  );
  return new Map(rows.map((r) => [String(r.subject), String(r.operation_id)]));
}

/**
 * #2045: the scope confirmed a move of this subject under `fence` — its mark goes, unless a newer
 * call has marked it since (a compare-and-set on the mark's operation id).
 */
export function clearSwitchOwed(
  db: SwitchSql,
  kind: SwitchKind,
  tenantId: string,
  scopeId: string,
  key: string,
  fence: string,
): void {
  db.run(
    `DELETE FROM _substrat_switch_owed
      WHERE tenant_id = ? AND scope_id = ? AND kind = ? AND subject = ? AND operation_id <= ?`,
    tenantId,
    scopeId,
    kind,
    key,
    fence,
  );
}

/**
 * #2045: does any subject on this scope still owe a re-assert? While one does, the scope's
 * reconcile receipt is not written (the control plane's `markScopeProvisioned`), so the sweep keeps
 * reconciling it until a re-assert has settled every mark.
 */
export function scopeOwesSwitch(db: SwitchSql, scopeId: string): boolean {
  return db.all(`SELECT 1 FROM _substrat_switch_owed WHERE scope_id = ? LIMIT 1`, scopeId).length > 0;
}

/** Each kind's DDL, for a pass that creates a table with its backfill. */
export const switchesDdlOf = (kind: SwitchKind): string => RECORDS[kind].ddl;

/**
 * The one-time backfill from the admin log: every switch moved before the record existed.
 * Without it, those are exactly the switches a wipe would still lose.
 *
 * It reads the admin-log shape the switch calls have written since they existed
 * (`revokeFromSystem` / `restoreToSystem` since #1666, `revokeFromPeer` / `restoreToPeer`
 * since #1706), two rows per call sharing `after.operationId`: an `intent` row carrying the
 * subject (`after.moduleId`, or `after.vertical` for a peer) and `after.reason`, then an
 * outcome row whose `after.phase` is `applied`, `refused` or `failed`. Only calls whose
 * outcome is `applied` count, because a refused call moved nothing and a failed one may not
 * have. Of those, only the LATEST per (tenant, scope, subject) is taken, by the intent's ULID
 * id. `at` is the intent's, the same instant the status read's who/why join reports. A key
 * whose calls include no applied OFF gets no row, even when its latest applied call is an ON:
 * history wrote no scope fence (#2045), so there is no fence for such a row to keep pace with,
 * and an ON-only key needs no record to re-assert.
 *
 * `INSERT OR IGNORE`, so a row the switch wrote itself is never overwritten by history.
 * The adapters run it only on the construction that creates the table, so it runs once.
 */
export function switchesBackfillSqlOf(kind: SwitchKind): string {
  const { table, key, actions, payloadKey } = RECORDS[kind];
  const [revoke, restore] = actions;
  return `
  WITH applied AS (
    SELECT DISTINCT action, json_extract(after, '$.operationId') AS operation_id
      FROM _substrat_admin_log
     WHERE action IN ('${revoke}', '${restore}')
       AND json_extract(after, '$.phase') = 'applied'
  ),
  intents AS (
    SELECT i.id AS id, i.tenant_id AS tenant_id, i.scope_id AS scope_id,
           json_extract(i.after, '$.${payloadKey}') AS subject_key,
           CASE i.action WHEN '${revoke}' THEN 'off' ELSE 'on' END AS position,
           i.actor AS actor,
           json_extract(i.after, '$.reason') AS reason,
           json_extract(i.after, '$.operationId') AS operation_id,
           i.at AS at
      FROM _substrat_admin_log i
      JOIN applied a
        ON a.action = i.action AND a.operation_id = json_extract(i.after, '$.operationId')
     WHERE i.action IN ('${revoke}', '${restore}')
       AND i.tenant_id IS NOT NULL AND i.scope_id IS NOT NULL
       AND json_extract(i.after, '$.phase') = 'intent'
       AND json_extract(i.after, '$.${payloadKey}') IS NOT NULL
       AND json_extract(i.after, '$.reason') IS NOT NULL
  ),
  ranked AS (
    SELECT *,
           ROW_NUMBER() OVER (PARTITION BY tenant_id, scope_id, subject_key ORDER BY id DESC) AS latest,
           MAX(position = 'off') OVER (PARTITION BY tenant_id, scope_id, subject_key) AS ever_off
      FROM intents
  )
  INSERT OR IGNORE INTO ${table}
    (tenant_id, scope_id, ${key}, position, actor, reason, operation_id, switched_at)
  SELECT tenant_id, scope_id, subject_key, position, actor, reason, operation_id, at
    FROM ranked
   WHERE latest = 1 AND ever_off = 1
`;
}

/**
 * Does a dump carry this kind's record table? A directory restore builds the table either way,
 * and backfills it from the dump's own admin log only when the dump did not (#1898). Compared
 * without case, as SQLite resolves a table name.
 */
export function dumpCarriesSwitches(names: readonly string[], kind: SwitchKind): boolean {
  const table = RECORDS[kind].table;
  return names.some((n) => n.toLowerCase() === table);
}

/** "Does this kind's record table exist yet?" — asked BEFORE the DDL, so the backfill runs once. */
export function switchesTableExists(db: SwitchSql, kind: SwitchKind): boolean {
  return (
    db.all(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`, RECORDS[kind].table)
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

/**
 * One scope's record rows of one kind, by subject (module id or peer slug) — what the per-scope
 * status read joins as `recorded`, and what a re-assert reverts a stale carry against.
 */
export function switchRecordsOf(
  db: SwitchSql,
  kind: SwitchKind,
  tenantId: string,
  scopeId: string,
): Map<string, 'on' | 'off'> {
  const { table, key } = RECORDS[kind];
  const rows = db.all(`SELECT ${key} AS k, position FROM ${table} WHERE tenant_id = ? AND scope_id = ?`, tenantId, scopeId);
  return new Map(rows.map((r) => [String(r.k), positionOf(r.position)]));
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

/** The subjects of one kind (module ids, or peer slugs) a reconcile must re-assert OFF on this scope. */
export function switchedOffOf(db: SwitchSql, kind: SwitchKind, tenantId: string, scopeId: string): string[] {
  const { table, key } = RECORDS[kind];
  return db
    .all(
      `SELECT ${key} AS k FROM ${table} WHERE tenant_id = ? AND scope_id = ? AND position = 'off' ORDER BY ${key}`,
      tenantId,
      scopeId,
    )
    .map((r) => String(r.k));
}

/**
 * The scopes of one tenant the record holds a module OFF on — what a tenant-level
 * `grantToSystem` refuses on (#1743). A tenant tuple has no scope of its own to read a
 * marker from, and reaches every scope of the tenant, so the directory's record is the only
 * place the question can be asked in one unit with the write. The adapters run this and the
 * tenant tuple's write together, on the handle both live on.
 */
export function scopesSwitchedOffFor(db: SwitchSql, tenantId: string, moduleId: string): string[] {
  return db
    .all(
      `SELECT scope_id FROM _substrat_system_switches
        WHERE tenant_id = ? AND module_id = ? AND position = 'off' ORDER BY scope_id`,
      tenantId,
      moduleId,
    )
    .map((r) => String(r.scope_id));
}

/**
 * Does the tenant hold a live TENANT-level grant for this subject (#1823, and #2030 for a peer)?
 * Asked of the directory, where the tenant tuple lives, and handed to the switch as
 * `tenantHeld`: a subject whose only authority on a scope is a tenant-level grant has nothing
 * in the scope's storage for the switch to find, and must still be switchable there. One
 * statement on both adapters' directories; the same "live" the evaluator judges a grant by
 * (unrevoked, unexpired at `now`).
 */
export function tenantHoldsGrant(db: SwitchSql, kind: SwitchKind, tenantId: string, key: string, now: string): boolean {
  const row = db.all(
    `SELECT EXISTS (SELECT 1 FROM _substrat_tenant_tuples
       WHERE tenant_id = ? AND subject = ? AND object = ? AND substr(relation, 1, 8) = 'granted:'
         AND ${liveTupleSql()}) AS held`,
    tenantId,
    `${RECORDS[kind].subjectPrefix}${key}`,
    `tenant:${tenantId}`,
    now,
  )[0] as { held: number } | undefined;
  return Number(row?.held) === 1;
}

/** Of `keys`, those the tenant holds a live tenant-level grant for (`tenantHoldsGrant`), in order. */
export function tenantHeldOf(db: SwitchSql, kind: SwitchKind, tenantId: string, keys: readonly string[], now: string): string[] {
  return keys.filter((key) => tenantHoldsGrant(db, kind, tenantId, key, now));
}

/** What one switch call writes into the record. `key` is the module id, or the peer's slug. */
export interface SwitchRecordWrite {
  kind: SwitchKind;
  tenantId: string;
  scopeId: string;
  key: string;
  actor: string;
  reason: string;
  operationId: string;
  at: string;
}

/** The row as it stood before a write, so a failed switch can put it back. */
export type SwitchRecordPrior = Pick<SystemSwitchRecordRow, 'position' | 'actor' | 'reason' | 'operationId' | 'at'> | null;

/** One record row's identity. */
type RecordKey = Pick<SwitchRecordWrite, 'kind' | 'tenantId' | 'scopeId' | 'key'>;

/**
 * What a re-assert did for one recorded-off subject — `HostAdmin.reassertSystemSwitches`'
 * answer: a module (`moduleId`) or, since #2029, a peer (`vertical`).
 */
export type SystemSwitchReassert = { held: boolean; changed: boolean } & (
  | { moduleId: string; vertical?: never }
  | { vertical: string; moduleId?: never }
);

/**
 * What the deployment reports it switched off inside the reconcile's own unit (#1742), passed
 * to `HostAdmin.reassertSystemSwitches` so the move is audited here. The re-assert that
 * follows finds those subjects already off (`changed: false`), and without this the admin log
 * would stop showing that a wiped scope was put back off.
 */
export interface SystemSwitchReassertOptions {
  appliedInUnit?: readonly InUnitReport[];
}

/** One in-unit move as a deployment reports it: a module's, or (#2029) a peer's. */
export type InUnitReport = Pick<SwitchedOff, 'changed' | 'permissions'> &
  ({ moduleId: string; vertical?: never } | { vertical: string; moduleId?: never });

/** The subject an in-unit report names, if it is of this kind. */
const reportKeyOf = (kind: SwitchKind, report: InUnitReport): string | undefined =>
  report[RECORDS[kind].payloadKey];

/**
 * The fields an audit row names its subject and position with — the shape each kind's switch
 * calls have always written (`moduleId` + `schedules`, `vertical` + `calls`).
 */
export function switchAuditSubject(
  kind: SwitchKind,
  key: string,
  position: 'on' | 'off',
): { moduleId: string; schedules: 'on' | 'off' } | { vertical: string; calls: 'on' | 'off' } {
  const { payloadKey, positionField } = RECORDS[kind];
  return { [payloadKey]: key, [positionField]: position } as ReturnType<typeof switchAuditSubject>;
}

/** The admin-log action a re-assert of this kind writes its rows under. */
export const reassertActionOf = (kind: SwitchKind): (typeof RECORDS)[SwitchKind]['reassertAction'] =>
  RECORDS[kind].reassertAction;

/** One re-assert answer entry: the subject by its kind's field, and what the move did. */
export const reassertEntry = (
  kind: SwitchKind,
  key: string,
  outcome: { held: boolean; changed: boolean },
): SystemSwitchReassert =>
  ({ [RECORDS[kind].payloadKey]: key, held: outcome.held, changed: outcome.changed }) as unknown as SystemSwitchReassert;

/**
 * #2045: the audit row (less its `operationId`) for a re-assert's ON that moved something — a
 * record of ON beside a scope that was off, converged to the record under its fence.
 */
export const reassertOnRow = (kind: SwitchKind, key: string, permissions: readonly string[]) => ({
  ...switchAuditSubject(kind, key, 'on'),
  phase: 'applied' as const,
  changed: true as const,
  permissions: [...permissions],
});

/** The audit row (less its `operationId`) for a re-assert's own OFF that moved something — both adapters. */
export const reassertOffRow = (kind: SwitchKind, key: string, permissions: readonly string[]) => ({
  ...switchAuditSubject(kind, key, 'off'),
  phase: 'applied' as const,
  changed: true as const,
  permissions: [...permissions],
});

/**
 * The re-assert's audit rows (less their `operationId`) for the in-unit moves of one kind:
 * those that changed something, on a subject the directory records `off` for this scope.
 * That filter is the point. The report comes from the deployment, and an audit row naming
 * a subject the record never switched off would be the deployment writing the platform's
 * log. One row per subject, first report wins. Built here so both adapters write one shape.
 */
export function inUnitMovesToAudit(
  kind: SwitchKind,
  recordedOff: readonly string[],
  applied: SystemSwitchReassertOptions['appliedInUnit'],
  /** Subjects this re-assert's stale-carry pass switched back on: their in-unit move is not credited. */
  reverted: ReadonlySet<string> = new Set(),
): (ReturnType<typeof switchAuditSubject> & { phase: 'applied'; changed: true; permissions: string[]; inUnit: true })[] {
  const off = new Set(recordedOff);
  const moves = new Map<string, string[]>();
  for (const a of applied ?? []) {
    const key = reportKeyOf(kind, a);
    if (key === undefined || reverted.has(key)) continue;
    if (a.changed && off.has(key) && !moves.has(key)) moves.set(key, [...a.permissions]);
  }
  return [...moves].map(([key, permissions]) => ({
    ...switchAuditSubject(kind, key, 'off'),
    phase: 'applied',
    changed: true,
    permissions,
    inUnit: true,
  }));
}

/**
 * The in-unit moves a STALE carry made, which the re-assert must undo (#1742 review): the
 * deployment switched a subject off because the list it was handed said so, but by the time
 * the re-assert reads the record, an operator's restore has moved it to `on`. The list was
 * read before the call and the ON landed in between. Left alone, the scope would stay off
 * while the record says on, and no later pass would put it back.
 *
 * Only a subject the record now holds `on`, so a revert only ever re-applies an operator's
 * own ON. It never turns on a subject whose record is `off` or missing, and so a report from
 * the deployment can never switch on anything the platform has not already restored.
 */
export function staleCarryReverts(
  kind: SwitchKind,
  recorded: ReadonlyMap<string, 'on' | 'off'>,
  applied: SystemSwitchReassertOptions['appliedInUnit'],
): string[] {
  const keys = (applied ?? []).flatMap((a) => {
    const key = reportKeyOf(kind, a);
    return key !== undefined && a.changed && recorded.get(key) === 'on' ? [key] : [];
  });
  return [...new Set(keys)];
}

/** The audit row (less its `operationId`) for one stale-carry revert — both adapters write this shape. */
export function staleCarryRevertRow(
  kind: SwitchKind,
  key: string,
  outcome: { changed: boolean; permissions: readonly string[] },
): ReturnType<typeof switchAuditSubject> & { phase: 'applied'; changed: boolean; permissions: string[]; staleCarry: true } {
  return {
    ...switchAuditSubject(kind, key, 'on'),
    phase: 'applied',
    changed: outcome.changed,
    permissions: [...outcome.permissions],
    staleCarry: true,
  };
}

/**
 * Overwrite one existing row's position and provenance — ON's write, and its undo. With
 * `ifOperationId`, only while the row is still the one that operation wrote (a CAS).
 */
function setRecordRow(db: SwitchSql, at: RecordKey, row: NonNullable<SwitchRecordPrior>, ifOperationId?: string): void {
  const { table, key } = RECORDS[at.kind];
  db.run(
    `UPDATE ${table}
        SET position = ?, actor = ?, reason = ?, operation_id = ?, switched_at = ?
      WHERE tenant_id = ? AND scope_id = ? AND ${key} = ?` + (ifOperationId === undefined ? '' : ' AND operation_id = ?'),
    row.position,
    row.actor,
    row.reason,
    row.operationId,
    row.at,
    at.tenantId,
    at.scopeId,
    at.key,
    ...(ifOperationId === undefined ? [] : [ifOperationId]),
  );
}

/** The row as it stands now, or null — what a write answers so its undo can put it back. */
function priorOf(db: SwitchSql, at: RecordKey): SwitchRecordPrior {
  const { table, key } = RECORDS[at.kind];
  const prior = db.all(
    `SELECT position, actor, reason, operation_id, switched_at FROM ${table}
      WHERE tenant_id = ? AND scope_id = ? AND ${key} = ?`,
    at.tenantId,
    at.scopeId,
    at.key,
  )[0];
  if (!prior) return null;
  return {
    position: positionOf(prior.position),
    actor: String(prior.actor),
    reason: String(prior.reason),
    operationId: String(prior.operation_id),
    at: String(prior.switched_at),
  };
}

/**
 * #2045: the record's half of the switch fence (`SWITCH_FENCES_DDL`). A write from a call OLDER than
 * the one the row holds writes nothing: a newer call has already recorded its position, and the
 * scope will refuse this call's move for the same reason. Both writes answer the prior row, and the
 * caller reads this off it, with the same test (`recordWriteSuperseded`).
 */
const supersededBy = (prior: SwitchRecordPrior, row: Pick<SwitchRecordWrite, 'operationId'>): boolean =>
  prior !== null && prior.operationId > row.operationId;

/** #2045: did this record write find a newer call's row, and so write nothing? */
export const recordWriteSuperseded = supersededBy;

/**
 * #2045: the operation id each of one scope's record rows of one kind holds, by subject — the fence a
 * re-assert or a carry moves the scope with, so a scope moved since by a newer call stays as that
 * call put it.
 */
export function switchFencesOf(db: SwitchSql, kind: SwitchKind, tenantId: string, scopeId: string): Map<string, string> {
  const { table, key } = RECORDS[kind];
  const rows = db.all(`SELECT ${key} AS k, operation_id FROM ${table} WHERE tenant_id = ? AND scope_id = ?`, tenantId, scopeId);
  return new Map(rows.map((r) => [String(r.k), String(r.operation_id)]));
}

/**
 * #2045: each record row's position AND operation id, by subject, in ONE read. A caller that moves
 * the scope to a row's position under the row's fence must take both from the same instant: read
 * apart, a row that moves between them pairs one call's position with another call's fence (an OFF
 * carried under the ON's fence applies, since the scope holds that very fence), and a row the undo
 * deleted between them is moved with no fence at all, which the scope applies unconditionally.
 */
export function switchRecordStatesOf(
  db: SwitchSql,
  kind: SwitchKind,
  tenantId: string,
  scopeId: string,
): Map<string, { position: 'on' | 'off'; fence: string }> {
  const { table, key } = RECORDS[kind];
  const rows = db.all(
    `SELECT ${key} AS k, position, operation_id FROM ${table} WHERE tenant_id = ? AND scope_id = ? ORDER BY ${key}`,
    tenantId,
    scopeId,
  );
  return new Map(rows.map((r) => [String(r.k), { position: positionOf(r.position), fence: String(r.operation_id) }]));
}

/** #2045: the tuple subject a record key names (`system:<m>`, `vertical:<v>`) — how a carry keys its fences. */
export const switchSubjectOf = (kind: SwitchKind, key: string): string => `${RECORDS[kind].subjectPrefix}${key}`;

/**
 * OFF's write, made BEFORE the scope's switch moves (#1823), and undone by
 * `restoreSwitchRecord` when the move throws or holds nothing. An upsert: a repeat OFF
 * refreshes the actor, reason and time, as the status read reports the latest reason.
 * Answers the row as it was.
 *
 * Before, because the other order left a window: between the scope moving and this write, a
 * tenant-level `grantToSystem` read no `off` row and was accepted (#1743's refusal reads this
 * table, in the unit that writes the tenant tuple). Written first, there is no instant at
 * which the scope is off and the record is not. This order fails toward a record of `off`
 * beside a scope still on, until the undo runs — the direction OFF wins anyway, and the one a
 * kill switch should fail in. Still never LEFT behind for a call that held nothing: a row
 * saying `off` for a subject the scope never had would switch it off on the day it is
 * installed (the kernel's `held` check, for the same reason).
 */
export function recordSwitchedOff(db: SwitchSql, row: SwitchRecordWrite): SwitchRecordPrior {
  return writeRecord(db, row, 'off');
}

/** Both writes' upsert: the row as this call's position, unless a newer call's row is there (#2045). */
function writeRecord(db: SwitchSql, row: SwitchRecordWrite, position: 'on' | 'off'): SwitchRecordPrior {
  const { table, key } = RECORDS[row.kind];
  const prior = priorOf(db, row);
  if (supersededBy(prior, row)) return prior;
  db.run(
    `INSERT INTO ${table}
       (tenant_id, scope_id, ${key}, position, actor, reason, operation_id, switched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, scope_id, ${key}) DO UPDATE SET
       position = excluded.position, actor = excluded.actor, reason = excluded.reason,
       operation_id = excluded.operation_id, switched_at = excluded.switched_at`,
    row.tenantId,
    row.scopeId,
    row.key,
    position,
    row.actor,
    row.reason,
    row.operationId,
    row.at,
  );
  return prior;
}

/**
 * ON's write, made BEFORE the scope's switch moves. Before, because the other order fails
 * unsafely: a scope switched on whose record write then failed would still read `off`, and the
 * next reconcile would switch the operator's restore back off. Answers the row as it was, for
 * `restoreSwitchRecord`.
 *
 * #2045: an upsert, like OFF's. An ON with no row before it writes one, because its move stores
 * its id in the scope's fence: without a row carrying the same id, an OLDER OFF arriving after
 * it would find no row to be refused by, record itself, and leave the directory behind the scope
 * (Codex r2). The directory's fence is never behind the scope's. An ON that holds nothing still
 * leaves no row: its undo removes the one it wrote.
 */
export function recordSwitchedOn(db: SwitchSql, row: SwitchRecordWrite): SwitchRecordPrior {
  return writeRecord(db, row, 'on');
}

/**
 * Put a row back as `recordSwitchedOn` or `recordSwitchedOff` found it — the call that wrote
 * it threw, or held nothing. A row that did not exist is removed again. A compare-and-set on
 * the call's own `operationId`: if another switch call has written the row since, the row is
 * left as that call wrote it, so an undo can never clobber a newer position.
 */
export function restoreSwitchRecord(
  db: SwitchSql,
  call: RecordKey & { operationId: string },
  prior: SwitchRecordPrior,
): void {
  if (prior) {
    setRecordRow(db, call, prior, call.operationId);
    return;
  }
  const { table, key } = RECORDS[call.kind];
  db.run(
    `DELETE FROM ${table} WHERE tenant_id = ? AND scope_id = ? AND ${key} = ? AND operation_id = ?`,
    call.tenantId,
    call.scopeId,
    call.key,
    call.operationId,
  );
}

/**
 * Forget one scope's switch records, of every kind — the scope's directory row is going too (a
 * reaped preview or fork, a reaped scope). Without this the fleet read keeps listing a switch on
 * a scope that no longer exists. The admin log keeps the history, as it keeps the scope's.
 */
export function forgetSwitchesOf(db: SwitchSql, scopeId: string): void {
  for (const kind of SWITCH_KINDS) db.run(`DELETE FROM ${RECORDS[kind].table} WHERE scope_id = ?`, scopeId);
  db.run(`DELETE FROM _substrat_switch_owed WHERE scope_id = ?`, scopeId);
}
