/**
 * The updated stamps, held true by the host (#2166).
 *
 * An entity that declares `updatedAt`/`updatedBy` (`EntityDef.stamps`) says so in `model.json`,
 * and that claim is held on every row a call names in `ctx.emit` — not only the rows a derived
 * write touched. What is read is the emits, not the writes: an emit about a stamped row counts as
 * a write to it, and a write that emits only about another entity is not seen. A derived
 * create and a derived update write the pair themselves; an authored handler is trusted to, and
 * this is what holds it to that. Both adapters run it around every operation and every consumer
 * delivery, inside the same transaction:
 *
 * 1. Before the guards and the handler, `watchUpdatedStamps` takes the outbox's insertion mark —
 *    unless no registered module declares the pair, in which case it reads nothing and returns
 *    `undefined`, and the call pays nothing at all.
 * 2. After the handler, `assertHeld` reads which rows the call emitted about since that mark, keeps
 *    those whose entity declares the pair, and reads each row's stamped columns by its id. A row
 *    that is gone (a delete) is skipped. Any other row must hold this call's `ctx.now()` and
 *    principal, or the call is refused `internal` and every write it made rolls back with it.
 *
 * **Why the outbox, not a record of `ctx.emit`.** An emit inside a `ctx.atomic` that was rolled
 * back is gone from the outbox with the writes it described, so the outbox is exactly what this
 * call is about to commit — on both adapters, with nothing to keep in step.
 *
 * **A kernel move is not checked.** `ctx.archive`, `ctx.trash` and `ctx.restore` write only the
 * kernel's own `_substrat_*` columns and emit kernel-authored types; those carry no module write,
 * so they are left out, and the move does not stamp the module's columns either.
 */
import {
  isKernelAuthoredEventType,
  substratError,
  type PrincipalId,
  type UpdatedStampDeclaration,
} from '@substrat-run/contracts';
import { quoted } from './derived-handlers.js';
import type { ScopedSql, SqlValue } from './scope-host.js';
import { OUTBOX_MARK_SQL } from './vertical-events.js';

/** One entity's updated stamps, and the module that declared them. */
export interface UpdatedStampPlan extends UpdatedStampDeclaration {
  readonly moduleId: string;
}

/** Add a module's `updatedStamps` to the host's map — one owner per entity type. */
export function addUpdatedStampPlans(
  byType: Map<string, UpdatedStampPlan>,
  moduleId: string,
  declarations: readonly UpdatedStampDeclaration[] | undefined,
): void {
  for (const declaration of declarations ?? []) {
    const existing = byType.get(declaration.entityType);
    if (existing) {
      throw new Error(
        `updated stamps: '${declaration.entityType}' is stamped by both '${existing.moduleId}' and '${moduleId}' — ` +
          'one entity type, one owner',
      );
    }
    byType.set(declaration.entityType, Object.freeze({ ...declaration, moduleId }));
  }
}

/** What `assertHeld` compares a stamped row against: the call's own instant and caller. */
export interface StampedBy {
  now(): string;
  readonly principal: PrincipalId;
}

export interface UpdatedStampWatch {
  /** Refuse the call unless every row it emitted about holds its updated stamps. */
  assertHeld(ctx: StampedBy, who: string): void;
}

/** The ids one `IN (…)` names — under the 100-parameter limit a Durable Object enforces. */
const ID_CHUNK = 90;

/**
 * Mark the outbox before a call, so `assertHeld` can read what the call emitted. `undefined` — and
 * no read — when no entity in the scope declares the updated pair.
 */
export function watchUpdatedStamps(
  sql: Pick<ScopedSql, 'query'>,
  plans: ReadonlyMap<string, UpdatedStampPlan>,
): UpdatedStampWatch | undefined {
  if (plans.size === 0) return undefined;
  const mark = Number(sql.query<{ mark: number }>(OUTBOX_MARK_SQL)[0]?.mark ?? 0);
  return {
    assertHeld(ctx, who) {
      const emitted = sql.query<{ type: string; entity_type: string; entity_id: string }>(
        'SELECT DISTINCT type, entity_type, entity_id FROM _substrat_outbox WHERE rowid > ?',
        [mark],
      );
      const idsByType = new Map<string, Set<string>>();
      for (const { type, entity_type: entityType, entity_id: id } of emitted) {
        if (!plans.has(entityType) || isKernelAuthoredEventType(type)) continue;
        const ids = idsByType.get(entityType) ?? new Set<string>();
        ids.add(id);
        idsByType.set(entityType, ids);
      }
      if (idsByType.size === 0) return;
      const now = ctx.now();
      const principal = String(ctx.principal);
      for (const [entityType, ids] of idsByType) {
        const plan = plans.get(entityType) as UpdatedStampPlan;
        const all = [...ids];
        for (let i = 0; i < all.length; i += ID_CHUNK) {
          const chunk = all.slice(i, i + ID_CHUNK);
          const rows = sql.query<{ id: string; at?: SqlValue; by?: SqlValue }>(
            `SELECT ${quoted(plan.idColumn)} AS id` +
              (plan.at !== undefined ? `, ${quoted(plan.at)} AS at` : '') +
              (plan.by !== undefined ? `, ${quoted(plan.by)} AS by` : '') +
              ` FROM ${quoted(plan.table)} WHERE ${quoted(plan.idColumn)} IN (${chunk.map(() => '?').join(', ')})`,
            chunk,
          );
          // A row that is gone is not in the answer: a delete has nothing left to stamp.
          for (const row of rows) {
            const stale =
              plan.at !== undefined && row.at !== now
                ? `'${plan.at}' does not hold this call's time`
                : plan.by !== undefined && row.by !== principal
                  ? `'${plan.by}' does not hold this call's principal`
                  : null;
            if (stale === null) continue;
            throw substratError(
              'internal',
              `${who}: it emitted about ${entityType} ${String(row.id)}, and ${stale} — '${entityType}' declares ` +
                'its updated stamps, so a call that emits about one of its rows sets them to ctx.now() and the calling principal (#2166)',
            );
          }
        }
      }
    },
  };
}
