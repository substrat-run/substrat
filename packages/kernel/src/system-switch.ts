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
 * switch was last pulled. The permission walk reads only `role:` and `granted:` relations,
 * so the marker authorizes nothing; what it denies, it denies through the one question the
 * evaluator asks before the walk (below).
 *
 * Switching off ALSO tombstones every live `granted:` tuple the module holds on the scope.
 * That is what makes it a kill switch rather than a schedule pause: anything that acts
 * with the module's system authority — a resumable job run (#1577), a `getSystemScope`
 * invoke — is denied by its own `ctx.check` while the switch is off.
 *
 * **And the checker reads the marker too** (#1823), which is what makes that denial hold
 * against a grant OFF cannot tombstone. A TENANT-level `system:` grant lives in the directory
 * (and in every scope's projection of it), not at `scope:<id>`, so OFF leaves it live. The
 * permission evaluator asks the scope reader's `switchedOff` before it reads any tuple, and a
 * live marker denies the subject on that scope whatever it holds (`permission-eval.ts`). The
 * write side stays closed as well, so a switched-off scope does not accumulate grants that
 * ON would then hand back:
 * - `grantToSystem` refuses while the module is switched off on that scope (the adapters
 *   ask `systemSwitchedOff` in the same unit as the write), and a tenant-level grant while
 *   the directory records it off on any scope (#1743);
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
  all(sql: string, ...params: (string | number | null)[]): Record<string, unknown>[];
  run(sql: string, ...params: (string | number | null)[]): void;
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
 * Which kill switch: a module's system authority (`system:<module>`, #1666) or a peer
 * vertical's (`vertical:<slug>`, #1706). Both move the same marker through `switchSubjectGrants`.
 */
export type SwitchKind = 'system' | 'peer';

/** The tuple-subject prefix of a peer vertical (#1706) — `vertical:acme/board-room`. Re-exported by `peer.ts`. */
export const PEER_SUBJECT_PREFIX = 'vertical:';

/** The tuple subject a peer's grants are seated under. The slug only, never the instance. Re-exported by `peer.ts`. */
export const peerSubjectRef = (vertical: string): string => `${PEER_SUBJECT_PREFIX}${vertical}`;

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
  return subjectGrantState(db, subjectOf(moduleId), now);
}

/**
 * The same gate for ANY switched subject (#1706) — `system:<module>` above, `vertical:<slug>`
 * for a peer. One statement, one spelling: the peer switch's status read must not be able to
 * disagree with the schedule switch's about what "off" and "ungranted" mean, and the surest
 * way to hold that is for there to be one predicate rather than two that look alike.
 */
export function subjectGrantState(db: SwitchSql, subject: string, now: string): SystemScheduleState {
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
  return subjectSwitchedOff(db, subjectOf(moduleId));
}

/**
 * `SYSTEM_SWITCH_OFF_PREDICATE` as a whole statement answering `off` (0/1), over the one bound
 * subject — what `subjectSwitchedOff` runs, and what each adapter's permission reader prepares
 * once and runs on every check of a switchable subject (#1823).
 */
export const SYSTEM_SWITCH_OFF_QUERY = `SELECT ${SYSTEM_SWITCH_OFF_PREDICATE} AS off`;

/** Is this subject's OFF marker live on the scope `db` is? Any subject — see `switchSubjectGrants`. */
export function subjectSwitchedOff(db: SwitchSql, subject: string): boolean {
  const row = db.all(SYSTEM_SWITCH_OFF_QUERY, subject)[0] as { off: number } | undefined;
  return Number(row?.off) === 1;
}

/**
 * The subject kinds a kill switch can name: a module's system authority (#1666, `system:`) and
 * a peer vertical's (#1706, `vertical:`). A principal, connection or capability never carries a
 * marker, so the evaluator asks the switch only for these (#1823).
 */
const SWITCHABLE_KINDS: ReadonlySet<string> = new Set(['system', 'vertical']);
export const isSwitchableSubjectKind = (kind: string): boolean => SWITCHABLE_KINDS.has(kind);

/** How many scopes a tenant-level refusal names before it says "and N more". */
const NAMED_SCOPES = 5;

const switchedOffMessage = (moduleId: string, where: string, reach: string): string =>
  `module '${moduleId}' is switched off on ${where} (#1666) — restore it first ` +
  `(restoreToSystem). A grant is not the lever: ${reach}granting while it is off would hand the ` +
  `module's system authority back to anything but its schedules.`;

/** The refusal `grantToSystem` throws while the switch is off — one wording, both adapters. */
export function systemSwitchedOffMessage(moduleId: string, scopeId: string): string {
  return switchedOffMessage(moduleId, `scope ${scopeId}`, '');
}

/**
 * The same refusal for a TENANT-level grant (#1743), naming the scopes the directory records
 * the module off on: a tenant tuple reaches every scope of the tenant, those included.
 */
export function tenantSystemSwitchedOffMessage(moduleId: string, scopeIds: readonly string[]): string {
  const named = scopeIds.slice(0, NAMED_SCOPES).join(', ');
  const more = scopeIds.length > NAMED_SCOPES ? ` and ${scopeIds.length - NAMED_SCOPES} more` : '';
  const where = scopeIds.length === 1 ? `scope ${named}` : `scopes ${named}${more}`;
  return switchedOffMessage(moduleId, where, 'a tenant-level grant reaches every scope of the tenant, so ');
}

/** What one switch call did in the scope's own storage — `SystemSwitchOutcome`'s shape. */
export interface SwitchOutcome {
  held: boolean;
  changed: boolean;
  permissions: string[];
  /**
   * #1823: this code's evaluator denies a module on a scope whose marker is live, its
   * TENANT-level grants included. Set by `switchSystemSchedules` on every answer, because it
   * is a fact about the code that answered, not about the call: a deployment built before
   * #1823 omits it, and its OFF leaves a tenant-level grant authorizing. The platform reads
   * its absence on an OFF of a module it found tenant-held as "this deployment cannot hold
   * that OFF", and refuses it rather than record a scope off that is not.
   */
  deniesTenantGrants?: true;
  /**
   * #2045: the move was refused, and nothing written, because the scope has already applied a
   * NEWER switch call on this subject (`SWITCH_FENCES_DDL`). The scope stays where the newer call
   * put it, which is also where the directory's record is. Absent from a deployment built before
   * the fence, which applies every move it is sent.
   */
  superseded?: true;
  /**
   * #2045 (Codex r2): this code honoured the call's fence — set on every answer to a move that
   * carried one, superseded or not. A deployment built before the fence drops the field and the
   * fence with it, and would apply an older call's move after a newer one, so the platform refuses
   * a fenced move whose answer lacks this, as it refuses an OFF without `deniesTenantGrants`.
   */
  fenced?: true;
}

/**
 * #2045: the fence a scope keeps per switched subject — the operation id (a ULID) of the newest
 * switch call it has applied. The directory's record (`system-switch-record.ts`) refuses a write
 * older than the one it holds, and the scope refuses a move older than the one it applied, so the
 * two always end on the SAME call's position, whatever order two concurrent calls' writes and moves
 * arrive in. Without it, operator A recording OFF, then B recording ON and moving ON, then A's OFF
 * landing, left the record ON beside a scope that is OFF, and a later restore re-admitted the
 * subject. Keyed by (subject, object) as the marker is, so a copy of another scope's rows fences
 * nothing here. Part of the scope's own storage: a restore or rewind takes it back with the marker.
 */
export const SWITCH_FENCES_DDL = `
  CREATE TABLE IF NOT EXISTS _substrat_switch_fences (
    subject TEXT NOT NULL,
    object  TEXT NOT NULL,
    -- The operation id of the newest switch call applied here. A ULID, so it orders by text.
    fence   TEXT NOT NULL,
    PRIMARY KEY (subject, object)
  );
`;

/**
 * Move one module's switch on one scope. Idempotent: a repeat changes nothing and says so.
 *
 * OFF tombstones every live `granted:` tuple the module holds at `scope:<id>`, records each
 * as `switched:<permission>`, and makes the marker live. ON un-tombstones exactly the
 * grants with a live `switched:` record, tombstones those records, and tombstones the
 * marker. A repeated OFF re-asserts the whole position: a grant that became live meanwhile
 * (only a raw write can do that now) is tombstoned and recorded too.
 *
 * `held: false`, with nothing written, when the module has no authority reaching the scope:
 * no grant and no marker here, and no live TENANT-level grant (`tenantHeld`, which the caller
 * reads from the directory, since the scope's storage cannot answer it). The caller named
 * something this scope never ran, and turning "nothing" off must not write a marker that
 * silently disables a module the day it is installed. A module whose only authority here is a
 * tenant-level grant IS held (#1823): OFF writes the marker, which the evaluator then denies
 * the module on, and tombstones nothing, because nothing of it is here to tombstone.
 *
 * Run it inside one transaction; the reads and writes here are meant to be one unit.
 */
export function switchSystemSchedules(
  db: SwitchSql,
  input: { moduleId: string; scopeId: string; to: 'on' | 'off'; at: string; tenantHeld?: boolean; fence?: string },
): SwitchOutcome {
  const { moduleId, ...rest } = input;
  const outcome = switchSubjectGrants(db, { subject: subjectOf(moduleId), ...rest });
  return { ...outcome, deniesTenantGrants: true };
}

/**
 * One subject `switchRecordedOff` switched off — `SwitchedOffInUnit`'s shape: a module
 * (`moduleId`), or since #2029 a peer vertical (`vertical`).
 */
export type SwitchedOff = SwitchOutcome & ({ moduleId: string; vertical?: never } | { vertical: string; moduleId?: never });

/**
 * What the platform carries into a unit that re-creates a scope's grants (#1742): the subjects
 * its directory records OFF on that scope, and of those, the ones held there only by a
 * tenant-level grant (#1823, #2030). Subjects only, never a scope: the unit names its own.
 */
export interface RecordedOffCarry {
  moduleIds: readonly string[];
  tenantHeld?: readonly string[];
  /** #2029: the recorded-off peers. Absent from a platform that predates the peer record. */
  verticals?: readonly string[];
  tenantHeldVerticals?: readonly string[];
  /**
   * #2045: the fence of each recorded-off subject, by tuple subject (`system:<m>`, `vertical:<v>`):
   * the operation id of the call the record holds. A subject the scope has since moved under a newer
   * call is left as that call put it. Absent from a platform built before the fence.
   */
  fences?: Readonly<Record<string, string>>;
}

/**
 * The same carry as it crosses the wire to a vertical's deployment (#1742): the provision,
 * reconcile and restore bodies, and `SwitchCarry` on the platform side. `switchedOffPeers` and
 * `tenantHeldPeers` are #2029's; a deployment built before them strips both, and the platform's
 * re-assert after the call switches those peers off instead.
 */
export interface SwitchCarryWire {
  switchedOff?: readonly string[];
  tenantHeld?: readonly string[];
  switchedOffPeers?: readonly string[];
  tenantHeldPeers?: readonly string[];
  /** #2045: `RecordedOffCarry.fences`, as it crosses the wire. A deployment built before it strips it. */
  switchFences?: Readonly<Record<string, string>>;
}

/** A wire carry as the unit runs it, or undefined when it names nothing to switch off. */
export function recordedOffFromWire(wire: SwitchCarryWire): RecordedOffCarry | undefined {
  if (!wire.switchedOff?.length && !wire.switchedOffPeers?.length) return undefined;
  return {
    moduleIds: wire.switchedOff ?? [],
    tenantHeld: wire.tenantHeld,
    verticals: wire.switchedOffPeers,
    tenantHeldVerticals: wire.tenantHeldPeers,
    fences: wire.switchFences,
  };
}

/**
 * Switch the directory's recorded-off subjects off again, inside the unit that re-created the
 * scope's grants (#1742): a provision's or reconcile's seat, or a restore's replay. The caller
 * runs it in that same unit, AFTER the seat, so the grants the seat created are the ones OFF
 * tombstones and records, and a later restore gives back exactly those (#1674's order). No
 * schedule can run, and no peer call be admitted, between the seat and this, because nothing
 * can run between them.
 *
 * `moduleIds` are the recorded-off modules, `verticals` the recorded-off peers (#2029). `scopeId`
 * is the scope `db` is, and the caller passes the one the request provisions or restores, never
 * a second id: the lists name subjects, never scopes, so they can only reach the scope that unit
 * is already writing. A subject the scope holds nothing for answers `held: false` and writes
 * nothing, as the switch always does — unless it is in `tenantHeld` / `tenantHeldVerticals`, the
 * recorded-off subjects the caller found a live tenant-level grant for (#1823, #2030). Off only:
 * nothing here turns anything on.
 */
export function switchRecordedOff(db: SwitchSql, input: RecordedOffCarry & { scopeId: string; at: string }): SwitchedOff[] {
  const tenantHeld = new Set(input.tenantHeld ?? []);
  const fenceOf = (subject: string): string | undefined => input.fences?.[subject];
  const modules: SwitchedOff[] = [...new Set(input.moduleIds)].map((moduleId) => ({
    moduleId,
    ...switchSystemSchedules(db, {
      moduleId,
      scopeId: input.scopeId,
      to: 'off',
      at: input.at,
      tenantHeld: tenantHeld.has(moduleId),
      fence: fenceOf(subjectOf(moduleId)),
    }),
  }));
  const peersHeld = new Set(input.tenantHeldVerticals ?? []);
  const peers: SwitchedOff[] = [...new Set(input.verticals ?? [])].map((vertical) => ({
    vertical,
    ...moveSwitch(db, 'peer', {
      key: vertical,
      scopeId: input.scopeId,
      to: 'off',
      at: input.at,
      tenantHeld: peersHeld.has(vertical),
      fence: fenceOf(peerSubjectRef(vertical)),
    }),
  }));
  return [...modules, ...peers];
}

/**
 * Move one kill switch of either kind on one scope (#2029): `switchSystemSchedules` for a
 * module, `switchSubjectGrants` over `vertical:<key>` for a peer. `key` is the module id or the
 * peer's slug. The one mover the adapters' shared switch body and their re-asserts call.
 */
export function moveSwitch(
  db: SwitchSql,
  kind: SwitchKind,
  input: { key: string; scopeId: string; to: 'on' | 'off'; at: string; tenantHeld?: boolean; fence?: string },
): SwitchOutcome {
  const { key, ...rest } = input;
  return kind === 'system'
    ? switchSystemSchedules(db, { moduleId: key, ...rest })
    : switchSubjectGrants(db, { subject: peerSubjectRef(key), ...rest });
}

/**
 * The switch itself, for ANY non-person subject's scope-level grants — `switchSystemSchedules`
 * for a schedule (`system:<module>`), and the peer kill switch for another vertical
 * (`vertical:<slug>`, #1706). One body, so the two levers cannot disagree about what OFF
 * tombstones, what ON gives back, or when a call held nothing. Everything said above
 * `switchSystemSchedules` holds for every subject: the marker is `SYSTEM_SWITCH_OFF_RELATION`,
 * and `seatScopeTuple`'s predicate is already bound per subject, so a marker blocks the seat
 * for exactly the subject it names.
 */
function switchSubjectGrants(
  db: SwitchSql,
  input: {
    subject: string;
    scopeId: string;
    to: 'on' | 'off';
    at: string;
    tenantHeld?: boolean;
    /**
     * #2045: the switch call this move belongs to — its operation id, or for a re-assert the one the
     * directory's record holds. A move older than the fence the scope keeps is refused (`superseded`);
     * one at or past it applies and moves the fence to it. Absent, the move applies and leaves the
     * fence alone: a caller from before the fence.
     */
    fence?: string;
  },
): SwitchOutcome {
  const object = `scope:${input.scopeId}`;
  const stored =
    input.fence === undefined
      ? undefined
      : (db.all(`SELECT fence FROM _substrat_switch_fences WHERE subject = ? AND object = ?`, input.subject, object)[0] as
          | { fence: string }
          | undefined);
  if (input.fence !== undefined && stored !== undefined && stored.fence > input.fence) {
    return { held: true, changed: false, permissions: [], superseded: true, fenced: true };
  }
  const outcome: SwitchOutcome = applySwitch(db, input, object);
  if (input.fence !== undefined) outcome.fenced = true;
  if (input.fence !== undefined && outcome.held) {
    db.run(
      `INSERT INTO _substrat_switch_fences (subject, object, fence) VALUES (?, ?, ?)
       ON CONFLICT (subject, object) DO UPDATE SET fence = excluded.fence`,
      input.subject,
      object,
      input.fence,
    );
  }
  return outcome;
}

/** `switchSubjectGrants`' move itself, once the fence has let it through. */
function applySwitch(
  db: SwitchSql,
  input: { subject: string; to: 'on' | 'off'; at: string; tenantHeld?: boolean },
  object: string,
): SwitchOutcome {
  const subject = input.subject;
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
  if (grants.length === 0 && !marker && !input.tenantHeld) return { held: false, changed: false, permissions: [] };

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
