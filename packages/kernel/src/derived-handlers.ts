/**
 * The handlers the platform writes from a declaration (#1773).
 *
 * `defineOperations` decides WHAT is derivable and records a plan for each `derive` declaration —
 * the table, its columns, the permission, the event (`DerivationPlan`, contracts). This turns a
 * plan into the handler. It takes the same steps a hand-written one does, through the same `ctx`
 * a module has: the declared check first, then `ctx.sql` over the entity's declared columns
 * (named, never `*`), `not_found` for a missing row, and one fat event per write.
 *
 * Nothing here decides a shape. A handler written from a plan cannot read a column, check a key or
 * emit an event the declaration did not name, because the plan holds nothing else.
 */
import {
  permissionKey,
  substratError,
  type DerivationPlan,
  type DerivedEmit,
  type EntityRef,
} from '@substrat-run/contracts';
import { assertAllowed } from './permission-checker.js';
import type { OperationContext, OperationHandler, SqlValue } from './scope-host.js';

type Row = Record<string, unknown>;
type Input = Record<string, unknown> | undefined;

/** `"col"` — a declared column is an identifier, quoted so a keyword-named one still reads as a column. */
const quoted = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`;

/** The handler a plan describes. */
export function derivedHandler(plan: DerivationPlan): OperationHandler<never, unknown> {
  const key = permissionKey.parse(plan.permission.key);
  const columns = plan.columns.map(quoted).join(', ');
  const select = `SELECT ${columns} FROM ${quoted(plan.table)} WHERE ${quoted(plan.primaryKey)} = ?`;
  const ref = (id: string): EntityRef => ({ entityType: plan.entity, entityId: id });

  const rowOrThrow = (ctx: OperationContext, id: string): Row => {
    const row = ctx.sql.query<Row>(select, [id])[0];
    if (!row) throw substratError('not_found', `${plan.entity} not found: ${id}`);
    return row;
  };

  /** The declared check: on the row the input names, or on its parent, or scope-wide. */
  const check = async (ctx: OperationContext, input: Input): Promise<void> => {
    const { entity, idFrom } = plan.permission;
    const decision =
      entity === undefined || idFrom === undefined
        ? await ctx.check(key)
        : await ctx.check(key, { entityType: entity, entityId: String(input?.[idFrom]) });
    assertAllowed(decision);
  };

  switch (plan.kind) {
    case 'get':
      return (async (ctx: OperationContext, input: Input) => {
        await check(ctx, input);
        return rowOrThrow(ctx, String(input?.[plan.idFrom]));
      }) as OperationHandler<never, unknown>;

    case 'list':
      return (async (ctx: OperationContext, input: Input) => {
        await check(ctx, input);
        const filters: Row = {};
        for (const { field, column } of plan.filters) {
          if (input?.[field] !== undefined) filters[column] = input[field];
        }
        return ctx.page<Row>(plan.entity, {
          limit: input?.limit as number | undefined,
          cursor: input?.cursor as string | undefined,
          sort: input?.sort as string | undefined,
          order: input?.order as 'asc' | 'desc' | undefined,
          filters,
          ...(plan.total ? { total: true } : {}),
        });
      }) as OperationHandler<never, unknown>;

    case 'update':
      return (async (ctx: OperationContext, input: Input) => {
        await check(ctx, input);
        const id = String(input?.[plan.idFrom]);
        rowOrThrow(ctx, id);
        // Absent is untouched, `null` clears: only the fields the caller sent are written.
        const sent = plan.fields.filter(({ field }) => input?.[field] !== undefined);
        // Nothing sent is nothing changed — no write, and no event to move the version.
        if (sent.length === 0) return rowOrThrow(ctx, id);
        ctx.sql.exec(
          `UPDATE ${quoted(plan.table)} SET ${sent.map(({ column }) => `${quoted(column)} = ?`).join(', ')} ` +
            `WHERE ${quoted(plan.primaryKey)} = ?`,
          // The plan admits only string and number columns, and the host parsed the input against them.
          [...sent.map(({ field }) => input?.[field] as SqlValue), id],
        );
        const row = rowOrThrow(ctx, id);
        ctx.emit(eventOf(plan.emit, ref(id), row));
        return row;
      }) as OperationHandler<never, unknown>;

    case 'delete':
      return (async (ctx: OperationContext, input: Input) => {
        await check(ctx, input);
        const id = String(input?.[plan.idFrom]);
        rowOrThrow(ctx, id);
        ctx.sql.exec(`DELETE FROM ${quoted(plan.table)} WHERE ${quoted(plan.primaryKey)} = ?`, [id]);
        const result = { id, deleted: true };
        ctx.emit(eventOf(plan.emit, ref(id), result));
        return result;
      }) as OperationHandler<never, unknown>;
  }
}

/** The declared event, its payload and subject drawn from what the operation answers with. */
function eventOf(emit: DerivedEmit, entity: EntityRef, output: Row): Parameters<OperationContext['emit']>[0] {
  const payload: Row = {};
  for (const field of emit.payload) payload[field] = output[field];
  return {
    type: emit.type,
    schemaVersion: emit.schemaVersion,
    entity,
    piiClass: emit.piiClass,
    ...(emit.subjectId !== undefined ? { subjectId: output[emit.subjectId] } : {}),
    payload,
  } as Parameters<OperationContext['emit']>[0];
}
