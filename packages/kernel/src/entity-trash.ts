/**
 * The trash, held by the host (#119 PR 2) — the half of K-45 a handler used to have to remember.
 *
 * Three things, written once for both adapters, the way `entity-state.ts` is:
 *
 * 1. **The refusal.** An operation that addresses an entity by id (`permission: { entity,
 *    idFrom }`) is refused on a TRASHED one before its guards and handler run, unless it
 *    declares `trashed: 'admits'` or `'purges'`. PR 1's review found handlers forgetting the
 *    per-handler check (`list-shares`, `revoke-share`); this makes it a mechanism.
 * 2. **The purge horizon.** An entity declaring `trash.purgeAfterDays` is permanently deleted
 *    once it has been in the bin that long, by the sweep running the module's own
 *    `trashed: 'purges'` operation as a derived schedule (`purgeSchedulesOf` in contracts), one
 *    entity per transaction.
 * 3. **Registration.** The checks that make both of those true of a module rather than of the
 *    modules that remembered a line.
 *
 * ## What the refusal does not reach, stated
 *
 * An operation whose check is `resolved` in the handler, narrowed by `refFrom`, or a `narrows`
 * walk has no entity the host can read off its input, so it is not refused here and keeps its
 * own `ctx.entityState` check. `trashRefusalGapsOf` names them and `lint:model` prints them.
 */
import {
  TRASHED_AT_COLUMN,
  declaredSurfaceOf,
  errorCodeOf,
  isStrictObjectSchema,
  substratError,
  type EntityRef,
  type EntityStateDeclaration,
  type OperationTarget,
  type ScheduleSpec,
} from '@substrat-run/contracts';
import { assertAllowed } from './permission-checker.js';
import { readStateRow, type EntityStatePlan, type StateCheck } from './entity-state.js';
import type { ScopedSql } from './scope-host.js';
import type { SystemScheduleState } from './system-switch.js';

/** How many entities one purge pass deletes per entity type. A full batch leaves the schedule due. */
export const PURGE_BATCH = 50;

/**
 * Is `entity` out of reach as a parent (#119): its type declares trash, and it is in the trash or
 * does not exist. The two answer as ONE, so `ctx.link` cannot be used to tell a binned entity from
 * a missing one. `false` for a type that declares no trash — the kernel never read those rows
 * before, and linking to one is unchanged.
 */
export function isUnreachableParent(sql: ScopedSql, plans: ReadonlyMap<string, EntityStatePlan>, entity: EntityRef): boolean {
  const plan = plans.get(entity.entityType);
  if (!plan?.trashPermission) return false;
  const row = readStateRow(sql, plan, entity.entityId);
  return !row || row.trashed_at !== null;
}

/** What the refusal needs from the adapter, inside the operation's own transaction. */
export interface TrashRefusalDeps {
  /** RAW access — the state columns are read, never written, but the guarded seam is module code's. */
  readonly sql: ScopedSql;
  readonly plans: ReadonlyMap<string, EntityStatePlan>;
  /** The operation's own check, so a pass is one of its authorizations and a denial is recorded as its own. */
  readonly check: StateCheck;
}

/**
 * Refuse an operation reaching a trashed entity it did not declare it reaches (#119).
 *
 * Runs after `BEGIN` and before the guards and the handler, for every caller and every door.
 *
 * **The order is the security property.** On a trashed entity the operation's DECLARED key is
 * checked first, exactly as the handler's first line would have: a caller without it gets the
 * `forbidden` an active entity would have given them, so the bin is not something they can
 * probe. Only a caller who holds the key learns it is gone — `not_found`, the answer the
 * per-handler check gave. An active entity is never checked here; the handler does it, as
 * always, so a pass is never recorded twice.
 *
 * `purge` is set only by the host's own purge sweep (`InvokeOptions` carries no such field, and an
 * adapter refuses a call that tries to supply one). The CUTOFF is computed here, from `now` — the
 * host's clock — and the entity's declared horizon, never taken from a caller: the entity must
 * still be trashed at or before it, or the purge is `conflict` (`purge_not_due`). So a restore
 * that landed between the sweep's selection and this turn wins, and nothing can purge early.
 */
export async function refuseTrashedTarget(
  deps: TrashRefusalDeps,
  operation: string,
  target: OperationTarget | undefined,
  input: unknown,
  purge?: { readonly now: string; readonly gate: PurgeGateFacts },
): Promise<void> {
  if (purge && target?.trashed !== 'purges') {
    throw substratError('internal', `${operation} is not a purge — only a \`trashed: 'purges'\` operation is run by the purge sweep`);
  }
  // A purge reaches one entity, whoever runs it: its PARSED input is the id and nothing else.
  // Registration requires a strict schema; this holds the parse result to it as well.
  if (target?.trashed === 'purges') assertPurgeInput(operation, target, input);
  // An operation that opted in reaches the bin as it is; only a purge re-checks its cutoff.
  if (!target || (target.trashed && !purge)) return;
  const plan = deps.plans.get(target.entity);
  if (!plan?.trashPermission) return;
  const id = (input as Record<string, unknown> | undefined)?.[target.idFrom];
  if (typeof id !== 'string') return;
  const row = readStateRow(deps.sql, plan, id);
  if (purge) {
    // The sweep's gate again, inside this purge's own transaction: a switch pulled, a lifecycle
    // hold or a copy classification that landed after the sweep began stops this purge here.
    const held = purgeHeldBy(purge.gate);
    if (held !== null) throw substratError('conflict', `${operation}: ${held}`, { reason: 'purge_held' });
    if (plan.purgeAfterDays === undefined) {
      throw substratError('internal', `${operation}: '${target.entity}' declares no purge horizon`);
    }
    const purgeCutoff = purgeCutoffOf(purge.now, plan.purgeAfterDays);
    if (!row) throw substratError('not_found', `${target.entity} not found: ${id}`);
    if (row.trashed_at === null || row.trashed_at > purgeCutoff) {
      throw substratError('conflict', `${operation}: ${target.entity}:${id} is no longer due for purge`, {
        reason: 'purge_not_due',
      });
    }
    return;
  }
  if (!row || row.trashed_at === null) return;
  assertAllowed(await deps.check(target.key as Parameters<StateCheck>[0], { entityType: target.entity, entityId: id }));
  throw substratError('not_found', `${target.entity} not found: ${id}`);
}

/** The parsed input of a `trashed: 'purges'` operation: a plain object holding exactly its id. */
function assertPurgeInput(operation: string, target: OperationTarget, input: unknown): void {
  const keys = typeof input === 'object' && input !== null && !Array.isArray(input) ? Object.keys(input) : undefined;
  if (keys?.length === 1 && keys[0] === target.idFrom) return;
  throw substratError('validation_failed', `${operation} purges one ${target.entity}: its input is '${target.idFrom}' and nothing else`, {
    errors: [{ path: '', message: `expected exactly { ${target.idFrom} }` }],
  });
}

/**
 * The keys a system principal's checks refuse on this call (#119): its module's purge-only keys,
 * unless the call is the host's own purge sweep invoking the purge operation. `undefined` —
 * nothing withheld — for any other subject, and for a module with no purge-only key.
 */
export function withheldKeysFor(
  purgeOnlyKeys: ReadonlySet<string> | undefined,
  target: OperationTarget | undefined,
  purging: boolean,
): ReadonlySet<string> | undefined {
  return purgeOnlyKeys && !(purging && target?.trashed === 'purges') ? purgeOnlyKeys : undefined;
}

/**
 * Refuse an invoke that tries to supply a purge from outside (#119). Purge authority comes only from
 * the host's own sweep, through a path no caller can construct; an options object carrying the
 * field is somebody trying, and is told so rather than silently ignored.
 */
export function assertNoCallerPurge(options: object | undefined): void {
  if (options && 'purgeCutoff' in options) {
    throw substratError('validation_failed', 'purgeCutoff is not an invoke option — only the platform\'s purge sweep purges', {
      errors: [{ path: 'purgeCutoff', message: 'not an invoke option' }],
    });
  }
}

/** The latest trash instant still due for purge at `now` — `now` minus the horizon. */
export function purgeCutoffOf(now: string, days: number): string {
  return new Date(Date.parse(now) - days * 86_400_000).toISOString();
}

/** A position in the purge walk's order: the trash instant and the id of the last entity tried. */
export interface PurgeKey {
  readonly at: string;
  readonly id: string;
}

/**
 * The ids due for purge: trashed at or before `cutoff`, oldest trash first, at most `limit` —
 * and, given `after`, only those strictly after it in that order (#2096). The predicate leads with
 * the purge index's own `WHERE`, so the walk reads only the bin; `after` is compared as a VALUE,
 * so a key whose entity has since been purged or restored still places the walk correctly.
 */
export function purgeCandidates(
  sql: ScopedSql,
  plan: EntityStatePlan,
  cutoff: string,
  limit = PURGE_BATCH,
  after: PurgeKey | null = null,
): PurgeKey[] {
  return sql
    .query<{ id: string; at: string }>(
      `SELECT ${plan.idColumn} AS id, ${TRASHED_AT_COLUMN} AS at FROM ${plan.table} ` +
        `WHERE ${TRASHED_AT_COLUMN} IS NOT NULL AND ${TRASHED_AT_COLUMN} <= ? ` +
        (after ? `AND (${TRASHED_AT_COLUMN}, ${plan.idColumn}) > (?, ?) ` : '') +
        `ORDER BY ${TRASHED_AT_COLUMN}, ${plan.idColumn} LIMIT ?`,
      after ? [cutoff, after.at, after.id, limit] : [cutoff, limit],
    )
    .map((r) => ({ id: String(r.id), at: String(r.at) }));
}

/**
 * A purge LAP in progress (#2096) — what a schedule's cadence row holds in `purge_cursor` between
 * passes. A lap walks the whole due bin, oldest first, `PURGE_BATCH` at a time; each pass resumes
 * after the last entity the one before it tried, whatever became of that entity. So entities that
 * keep failing cannot hold the head of the walk: the walk moves past them, reaches everything due
 * behind them in the same lap, and tries them again in the next.
 *
 * `failed` counts the purges that failed in the lap's earlier passes, so the pass that closes the
 * lap — the one that writes the cadence row — records the lap `failed` even when its own batch
 * succeeded.
 */
export interface PurgeLap {
  /** Where the next pass resumes, or null at the start of a lap. */
  readonly after: PurgeKey | null;
  readonly failed: number;
}

const LAP_START: PurgeLap = { after: null, failed: 0 };

/**
 * The lap a stored `purge_cursor` holds. NULL — no lap in progress, a row written before the
 * column, or no row at all — is the start of a lap, and so is a value this code cannot read: the
 * worst a lost cursor costs is walking from the oldest again.
 */
export function purgeLapOf(stored: string | null | undefined): PurgeLap {
  if (stored === null || stored === undefined) return LAP_START;
  try {
    const v = JSON.parse(stored) as { at?: unknown; id?: unknown; failed?: unknown };
    if (typeof v.at !== 'string' || typeof v.id !== 'string') return LAP_START;
    const failed = typeof v.failed === 'number' && Number.isSafeInteger(v.failed) && v.failed > 0 ? v.failed : 0;
    return { after: { at: v.at, id: v.id }, failed };
  } catch {
    return LAP_START;
  }
}

/** Read the purge schedule's lap from its cadence row (`kind = 'schedule'`, keyed by the operation). */
export function readPurgeLap(sql: ScopedSql, operation: string): PurgeLap {
  const [row] = sql.query<{ purge_cursor: string | null }>(
    `SELECT purge_cursor FROM _substrat_schedule_state WHERE kind = 'schedule' AND schedule_op = ?`,
    [operation],
  );
  return purgeLapOf(row?.purge_cursor);
}

/** Store a lap's next start (NULL when none), touching `purge_cursor` alone — see `runPurgePass`. */
function writePurgeLap(sql: ScopedSql, operation: string, lap: PurgeLap | null): void {
  sql.exec(
    `INSERT INTO _substrat_schedule_state (kind, schedule_op, purge_cursor) VALUES ('schedule', ?, ?)
     ON CONFLICT(kind, schedule_op) DO UPDATE SET purge_cursor = excluded.purge_cursor`,
    [operation, lap?.after ? JSON.stringify({ at: lap.after.at, id: lap.after.id, failed: lap.failed }) : null],
  );
}

/** One purge horizon's due work on a scope, for one pass of its lap. */
export interface PurgeDue {
  readonly cutoff: string;
  /** The purge operation's input field carrying the id. */
  readonly idFrom: string;
  /** The ids this pass tries, in the walk's order. */
  readonly ids: string[];
  /** The lap as this pass found it. */
  readonly lap: PurgeLap;
  /** Where the next pass resumes when more is due after these ids — or null: this pass closes the lap. */
  readonly next: PurgeKey | null;
}

/**
 * One purge horizon's due work on a scope (#119, #2096): the cutoff, the input field carrying the
 * id, and the next `limit` due ids of the lap the cadence row records — read one past the batch, so
 * `more` is known rather than guessed from a full batch. Registration has tied the schedule to a
 * declared horizon and the entity's purge operation, so a miss here is a wiring fault.
 */
export function purgeDueOf(
  sql: ScopedSql,
  plans: ReadonlyMap<string, EntityStatePlan>,
  targets: ReadonlyMap<string, OperationTarget>,
  operation: string,
  entityType: string,
  now: string,
  limit = PURGE_BATCH,
): PurgeDue {
  const plan = plans.get(entityType);
  const target = targets.get(operation);
  if (plan?.purgeAfterDays === undefined || !target) {
    throw new Error(`purge: '${operation}' is not the purge operation of a horizon on '${entityType}'`);
  }
  const cutoff = purgeCutoffOf(now, plan.purgeAfterDays);
  const lap = readPurgeLap(sql, operation);
  const keys = purgeCandidates(sql, plan, cutoff, limit + 1, lap.after);
  const batch = keys.slice(0, limit);
  return {
    cutoff,
    idFrom: target.idFrom,
    ids: batch.map((k) => k.id),
    lap,
    next: keys.length > limit ? batch.at(-1)! : null,
  };
}

/**
 * What the purge sweep's gate reads (#119), each fact from the scope's OWN state as the adapter
 * holds it — never from the caller. The adapter reads them before the sweep selects anything and
 * again inside each purge's transaction, and both go through `purgeHeldBy`.
 */
export interface PurgeGateFacts {
  /** The module's kill switch on this scope (`systemScheduleState`). */
  readonly switched: SystemScheduleState;
  /** The scope's lifecycle refusal (`lifecycleRefusal`), or null when it may run or none is held. */
  readonly lifecycle: string | null;
  /** Whether the scope is a copy — a fork, a snapshot or a preview — rather than the primary install. */
  readonly copy: boolean;
  /** Whether the tenant the sweep names is foreign to the scope's own record (`tenantVerdict`). */
  readonly foreignTenant: boolean;
}

/**
 * THE purge sweep's gate (#119): why this scope may purge nothing now, or null when it may. The
 * same holds the coordinator applies before any schedule fires, applied by the scope itself from
 * whatever of them it records (below: on a directory-backed host, the kill switch). A tenant foreign to the scope is a REFUSAL (`not_found`,
 * the doors' answer for a pair that does not hold), not a hold: nothing about it is "not yet".
 *
 * On a directory-backed host the scope DO enforces the kill switch; tenant, lifecycle, copy and
 * rewind holds are enforced by the coordinator. The scope holds no tenant receipt, lifecycle or copy
 * classification of its own there (the directory is their authority), so those facts read clear —
 * an unrecorded tenant is `unknown`, which passes as at every door.
 */
export function purgeHeldBy(facts: PurgeGateFacts): string | null {
  if (facts.foreignTenant) throw substratError('not_found', 'purge refused: the tenant named is not this scope\'s');
  if (facts.switched !== 'on') return `the module's schedules are ${facts.switched === 'off' ? 'switched off' : 'not granted'} on this scope`;
  if (facts.lifecycle !== null) return facts.lifecycle;
  if (facts.copy) return 'this scope is a copy, and a copy never purges';
  return null;
}

/** What one purge schedule did on one scope in one pass. */
export interface PurgePass {
  /** Entities the operation deleted. */
  purged: number;
  /** Entities restored or already gone by their turn — not failures. */
  skipped: number;
  /** One entry per entity whose purge threw for any other reason; it stays in the bin and is retried. */
  errors: { entityId: string; error: string }[];
  /** More is due after this batch: the lap continues, and the schedule stays due (`purgeStillDue`). */
  more: boolean;
  /**
   * Purges that failed in the EARLIER passes of the lap this pass closed (#2096) — so the cadence
   * row this pass writes says the lap failed, even when this batch did not. 0 while the lap goes on.
   * Absent, like `more`, from a scope running code older than the lap, which ran no lap.
   */
  lapFailed?: number;
  /** Why the scope ran no purge at all this pass (`purgeHeldBy`), when its gate held it. */
  held?: string;
}

/** A pass the scope's gate held: nothing selected, nothing tried, the lap where it was. */
export function heldPurgePass(held: string): PurgePass {
  return { purged: 0, skipped: 0, errors: [], more: false, lapFailed: 0, held };
}

/**
 * Run one pass of a purge schedule over the ids the adapter selected (`purgeDueOf`), then record
 * what it did to its lap (#2096). One invoke per entity, each its own transaction, so a crash or a
 * failure loses nothing already committed and the next pass simply selects what is left. An entity
 * that was restored (`purge_not_due`) or is already gone (`not_found`) is skipped, never a failure —
 * the purge is idempotent by state.
 *
 * Then the lap moves on WHATEVER its purges did — that is the whole of #2096: resume after this
 * batch with its failures added while more is due, or close the lap. After the pass, so a pass cut
 * short repeats its batch rather than skipping it. `inScope` runs the write against the scope's
 * spine, in the turn the adapter's storage needs.
 */
export async function runPurgePass(
  operation: string,
  due: PurgeDue,
  purgeOne: (entityId: string) => Promise<void>,
  inScope: (write: (sql: ScopedSql) => void) => unknown,
): Promise<PurgePass> {
  const more = due.next !== null;
  const pass: PurgePass = { purged: 0, skipped: 0, errors: [], more, lapFailed: more ? 0 : due.lap.failed };
  for (const entityId of due.ids) {
    try {
      await purgeOne(entityId);
      pass.purged += 1;
    } catch (err) {
      const code = errorCodeOf(err);
      const reason = (err as { extensions?: { reason?: unknown } }).extensions?.reason;
      if (code === 'not_found' || (code === 'conflict' && (reason === 'purge_not_due' || reason === 'purge_held'))) {
        pass.skipped += 1;
        continue;
      }
      pass.errors.push({ entityId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  // A lap that began at the oldest and closes in this pass leaves the cursor NULL, as it found it.
  if (more || due.lap.after !== null) {
    const next = due.next ? { after: due.next, failed: due.lap.failed + pass.errors.length } : null;
    await inScope((sql) => writePurgeLap(sql, operation, next));
  }
  return pass;
}

/**
 * Whether a purge pass leaves its schedule due, so the next sweep pass continues its lap rather
 * than waiting the cadence: more is due after its batch (#2096). It cannot spin (#2087): every pass
 * moves the lap strictly forward, whatever its purges did, and the pass that runs out of due
 * entities closes the lap and records the run — so a cadence window holds one lap, and an entity
 * that keeps failing is tried once per window, not once per sweep tick. A scope running code older
 * than the lap answers no `more`, and its pass waits its cadence.
 */
export function purgeStillDue(pass: PurgePass): boolean {
  return pass.more === true;
}

/**
 * The keys a module's system principal holds ONLY for its purge schedules (#119): declared by a
 * purge schedule and by no other. Withheld from every system-principal check except the purge
 * sweep's own invoke of the purge operation, so the scope-wide grant seated for a purge cannot
 * run anything else — another operation checking the same key, a job step, a host-level call.
 */
export function purgeOnlyKeysOf(schedules: readonly ScheduleSpec[]): ReadonlySet<string> | undefined {
  const purge = new Set(schedules.filter((s) => s.purge).flatMap((s) => s.permissions));
  for (const s of schedules) if (!s.purge) for (const p of s.permissions) purge.delete(p);
  return purge.size > 0 ? purge : undefined;
}

/**
 * A purge pass, as the schedule run reports it: one error row per entity that failed (labelled
 * with its id), and the error that marks the schedule's run `failed` when any did — in this pass,
 * or in an earlier pass of the lap this one closed (#2096), so the cadence row keeps the failure.
 */
export function purgeReportOf(
  operation: string,
  entityType: string,
  pass: PurgePass,
): { errors: { operation: string; error: string }[]; failure?: Error } {
  const errors = pass.errors.map((e) => ({ operation: `${operation} (${entityType}:${e.entityId})`, error: e.error }));
  const earlier = pass.lapFailed ?? 0;
  if (errors.length === 0 && earlier === 0) return { errors };
  const counts = [errors.length > 0 && `${errors.length} purge(s) of ${entityType} failed`, earlier > 0 && `${earlier} failed earlier in this lap`];
  return { errors, failure: new Error(`${counts.filter(Boolean).join('; ')}; they stay in the bin and are retried`) };
}

/**
 * Hold one module's registration to the trash rules (#119), and answer the targets the host
 * keeps. Refuses, never skips — each of these is a binned entity reachable while the module
 * believes it is not:
 *
 * The targets are DERIVED, never handed over: `operationInputsOf(ops)` records the declared
 * surface of the frozen map it returns (`declaredSurfaceOf`, which nothing else can write), and the
 * host reads each operation's target off the same declaration it parses with. A module with a trashable entity must therefore
 * - pass `operationInputs` built by `operationInputsOf`, so there is a declared surface to read;
 * - declare every operation it binds there — an undeclared one could address a binned entity and
 *   the host could not see which;
 * - declare a `trashed: 'purges'` operation whose input is a strict object holding the id and nothing else.
 *
 * Also refused: an opt-in on an entity that declares no trash here, a purge horizon without
 * exactly the schedule `purgeSchedulesOf` derives for it, and a purge schedule that does not run
 * the entity's `trashed: 'purges'` operation.
 */
export function registerTrashTargets(
  moduleId: string,
  ownOps: ReadonlySet<string>,
  operationInputs: Readonly<Record<string, unknown>> | undefined,
  entityStates: readonly EntityStateDeclaration[] | undefined,
  schedules: readonly ScheduleSpec[] | undefined,
): Map<string, OperationTarget> {
  const trashable = new Map((entityStates ?? []).filter((d) => d.trashPermission).map((d) => [d.entityType, d]));
  const surface = declaredSurfaceOf(operationInputs);
  if (trashable.size > 0) {
    const where = `${moduleId} declares trashable entities (${[...trashable.keys()].sort().join(', ')})`;
    if (!surface) {
      throw new Error(
        `${where} but its \`operationInputs\` is not a map \`operationInputsOf\` returned — the host could not see which ` +
          'operations address a binned one. A copy, a spread or an edited map is not one, and nor is a map built by a ' +
          'second copy of @substrat-run/contracts.\n  Remedy: bind with `...operationsFor(ops)({ … })`, which hands the map over as returned.',
      );
    }
    const undeclared = [...ownOps].filter((name) => !surface.operations.includes(name)).sort();
    if (undeclared.length > 0) {
      throw new Error(
        `${where} and binds operation(s) its declarations do not name: ${undeclared.join(', ')} — the host could not ` +
          'tell which entity they reach, so it could not refuse them on a binned one. Declare them.',
      );
    }
  }
  const out = new Map<string, OperationTarget>();
  for (const [name, target] of Object.entries(surface?.targets ?? {})) {
    if (!ownOps.has(name)) continue; // declared and not bound here: nothing to refuse
    if (target.trashed === 'purges') {
      const schema = operationInputs?.[name];
      const fields = Object.keys((schema as { shape?: Record<string, unknown> } | undefined)?.shape ?? {});
      if (fields.length !== 1 || fields[0] !== target.idFrom) {
        throw new Error(
          `${moduleId}: '${name}' purges '${target.entity}', and its parsed input takes ${fields.map((f) => `'${f}'`).join(', ') || 'nothing'} — ` +
            `a purge's input is '${target.idFrom}' and nothing else, so it reaches only the entity it is run for`,
        );
      }
      // The shape alone is not the parsed result: a passthrough object keeps whatever else the
      // call carried. Strict, so an extra field is refused rather than kept or dropped.
      if (!isStrictObjectSchema(schema)) {
        throw new Error(
          `${moduleId}: '${name}' purges '${target.entity}', and its input is not a strict object — a passthrough one ` +
            `keeps fields beside '${target.idFrom}'.\n  Remedy: \`input: z.strictObject({ ${target.idFrom}: … })\`.`,
        );
      }
    }
    if (target.trashed && !trashable.has(target.entity)) {
      throw new Error(`${moduleId}: '${name}' declares \`trashed: '${target.trashed}'\` over '${target.entity}', which declares no trash here`);
    }
    out.set(name, target);
  }
  for (const schedule of schedules ?? []) {
    if (!schedule.purge) continue;
    const decl = trashable.get(schedule.purge.entityType);
    const target = out.get(schedule.operation);
    if (decl?.purgeAfterDays === undefined || target?.trashed !== 'purges' || target.entity !== schedule.purge.entityType) {
      throw new Error(
        `${moduleId}: the purge schedule for '${schedule.purge.entityType}' runs '${schedule.operation}', which is not ` +
          "that entity's `trashed: 'purges'` operation over a declared horizon — derive it with `purgeSchedulesOf`",
      );
    }
  }
  for (const [entityType, decl] of trashable) {
    if (decl.purgeAfterDays === undefined) continue;
    const count = (schedules ?? []).filter((s) => s.purge?.entityType === entityType).length;
    if (count !== 1) {
      throw new Error(
        `${moduleId}: '${entityType}' declares a purge horizon and ${count} purge schedules — ` +
          'spread `purgeSchedulesOf(ops, entities)` into the manifest\'s `schedules` once',
      );
    }
  }
  return out;
}
