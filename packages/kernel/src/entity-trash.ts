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
  errorCodeOf,
  substratError,
  type EntityRef,
  type EntityStateDeclaration,
  type OperationTarget,
  type ScheduleSpec,
} from '@substrat-run/contracts';
import { assertAllowed } from './permission-checker.js';
import { readStateRow, type EntityStatePlan, type StateCheck } from './entity-state.js';
import type { ScopedSql } from './scope-host.js';

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
  purge?: { readonly now: string },
): Promise<void> {
  if (purge && target?.trashed !== 'purges') {
    throw substratError('internal', `${operation} is not a purge — only a \`trashed: 'purges'\` operation is run by the purge sweep`);
  }
  // An operation that opted in reaches the bin as it is; only a purge re-checks its cutoff.
  if (!target || (target.trashed && !purge)) return;
  const plan = deps.plans.get(target.entity);
  if (!plan?.trashPermission) return;
  const id = (input as Record<string, unknown> | undefined)?.[target.idFrom];
  if (typeof id !== 'string') return;
  const row = readStateRow(deps.sql, plan, id);
  if (purge) {
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

/**
 * The ids due for purge: trashed at or before `cutoff`, oldest trash first, at most `limit`.
 * The predicate leads with the purge index's own `WHERE`, so the walk reads only the bin.
 */
export function purgeCandidates(sql: ScopedSql, plan: EntityStatePlan, cutoff: string, limit = PURGE_BATCH): string[] {
  return sql
    .query<{ id: string }>(
      `SELECT ${plan.idColumn} AS id FROM ${plan.table} ` +
        `WHERE ${TRASHED_AT_COLUMN} IS NOT NULL AND ${TRASHED_AT_COLUMN} <= ? ` +
        `ORDER BY ${TRASHED_AT_COLUMN}, ${plan.idColumn} LIMIT ?`,
      [cutoff, limit],
    )
    .map((r) => String(r.id));
}

/**
 * One purge horizon's due work on a scope: the cutoff, the input field carrying the id, and the
 * oldest due ids. Registration has tied the schedule to a declared horizon and the entity's
 * purge operation, so a miss here is a wiring fault.
 */
export function purgeDueOf(
  sql: ScopedSql,
  plans: ReadonlyMap<string, EntityStatePlan>,
  targets: ReadonlyMap<string, OperationTarget>,
  operation: string,
  entityType: string,
  now: string,
  limit = PURGE_BATCH,
): { cutoff: string; idFrom: string; ids: string[] } {
  const plan = plans.get(entityType);
  const target = targets.get(operation);
  if (plan?.purgeAfterDays === undefined || !target) {
    throw new Error(`purge: '${operation}' is not the purge operation of a horizon on '${entityType}'`);
  }
  const cutoff = purgeCutoffOf(now, plan.purgeAfterDays);
  return { cutoff, idFrom: target.idFrom, ids: purgeCandidates(sql, plan, cutoff, limit) };
}

/** What one purge schedule did on one scope in one pass. */
export interface PurgePass {
  /** Entities the operation deleted. */
  purged: number;
  /** Entities restored or already gone by their turn — not failures. */
  skipped: number;
  /** One entry per entity whose purge threw for any other reason; it stays in the bin and is retried. */
  errors: { entityId: string; error: string }[];
  /** The batch was full: the schedule stays due, so the next sweep pass continues. */
  full: boolean;
}

/**
 * Run one purge schedule over the ids the adapter selected (`purgeCandidates`): one invoke per
 * entity, each its own transaction, so a crash or a failure loses nothing already committed and
 * the next pass simply selects what is left. An entity that was restored (`purge_not_due`) or is
 * already gone (`not_found`) is skipped, never a failure — the purge is idempotent by state.
 */
export async function runPurgePass(
  ids: readonly string[],
  limit: number,
  purgeOne: (entityId: string) => Promise<void>,
): Promise<PurgePass> {
  const pass: PurgePass = { purged: 0, skipped: 0, errors: [], full: ids.length >= limit };
  for (const entityId of ids) {
    try {
      await purgeOne(entityId);
      pass.purged += 1;
    } catch (err) {
      const code = errorCodeOf(err);
      const reason = (err as { extensions?: { reason?: unknown } }).extensions?.reason;
      if (code === 'not_found' || (code === 'conflict' && reason === 'purge_not_due')) {
        pass.skipped += 1;
        continue;
      }
      pass.errors.push({ entityId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return pass;
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
 * with its id), and the error that marks the schedule's run `failed` when any did.
 */
export function purgeReportOf(
  operation: string,
  entityType: string,
  pass: PurgePass,
): { errors: { operation: string; error: string }[]; failure?: Error } {
  const errors = pass.errors.map((e) => ({ operation: `${operation} (${entityType}:${e.entityId})`, error: e.error }));
  return errors.length === 0
    ? { errors }
    : { errors, failure: new Error(`${errors.length} purge(s) of ${entityType} failed; they stay in the bin and are retried`) };
}

/**
 * Hold one module's registration to the trash rules (#119), and answer the targets the host
 * keeps. Refuses, never skips — each of these is a binned entity reachable while the module
 * believes it is not:
 *
 * The targets are DERIVED, never handed over: `operationInputsOf(ops)` records the declared
 * surface beside the schemas (`DECLARED_SURFACE`), and the host reads each operation's target off
 * the same declaration it parses with. A module with a trashable entity must therefore
 * - pass `operationInputs` built by `operationInputsOf`, so there is a declared surface to read;
 * - declare every operation it binds there — an undeclared one could address a binned entity and
 *   the host could not see which;
 * - declare a `trashed: 'purges'` operation whose parsed input is the id and nothing else.
 *
 * Also refused: an opt-in on an entity that declares no trash here, a purge horizon without
 * exactly the schedule `purgeSchedulesOf` derives for it, and a purge schedule that does not run
 * the entity's `trashed: 'purges'` operation.
 */
export function registerTrashTargets(
  moduleId: string,
  ownOps: ReadonlySet<string>,
  targets: Readonly<Record<string, OperationTarget>> | undefined,
  entityStates: readonly EntityStateDeclaration[] | undefined,
  schedules: readonly ScheduleSpec[] | undefined,
): Map<string, OperationTarget> {
  const trashable = new Map((entityStates ?? []).filter((d) => d.trashPermission).map((d) => [d.entityType, d]));
  const surface = declaredSurfaceOf(operationInputs);
  if (trashable.size > 0) {
    const where = `${moduleId} declares trashable entities (${[...trashable.keys()].sort().join(', ')})`;
    if (!surface) {
      throw new Error(
        `${where} but its \`operationInputs\` were not built by \`operationInputsOf\` — the host could not see which ` +
          'operations address a binned one.\n  Remedy: `operationInputs: operationInputsOf(ops)`.',
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
      const shape = (operationInputs?.[name] as { shape?: Record<string, unknown> } | undefined)?.shape;
      const fields = Object.keys(shape ?? {});
      if (fields.length !== 1 || fields[0] !== target.idFrom) {
        throw new Error(
          `${moduleId}: '${name}' purges '${target.entity}', and its parsed input takes ${fields.map((f) => `'${f}'`).join(', ') || 'nothing'} — ` +
            `a purge's input is '${target.idFrom}' and nothing else, so it reaches only the entity it is run for`,
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
