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
  type DerivedParent,
  type DerivedStamp,
  type EntityRef,
} from '@substrat-run/contracts';
import { assertAllowed } from './permission-checker.js';
import { ulid } from './ulid.js';
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

  const body = bodyOf(plan, rowOrThrow, ref);
  return (async (ctx: OperationContext, input: Input) => {
    await check(ctx, input);
    return body(ctx, input);
  }) as OperationHandler<never, unknown>;
}

/** What the handler does once the check has passed. */
function bodyOf(
  plan: DerivationPlan,
  rowOrThrow: (ctx: OperationContext, id: string) => Row,
  ref: (id: string) => EntityRef,
): (ctx: OperationContext, input: Input) => unknown {
  switch (plan.kind) {
    case 'get':
      return (ctx, input) => rowOrThrow(ctx, String(input?.[plan.idFrom]));

    case 'list':
      return (ctx, input) => {
        // A page of a parent's rows names the parent: one that does not exist is not an empty page.
        if (plan.parent) parentOrThrow(ctx, plan.parent, input);
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
      };

    case 'update':
      return (ctx, input) => {
        const id = String(input?.[plan.idFrom]);
        const existing = rowOrThrow(ctx, id);
        // Absent is untouched, `null` clears: only the fields the caller sent are written.
        const sent = plan.fields.filter(({ field }) => input?.[field] !== undefined);
        // Nothing sent is nothing changed — no write, and no event to move the version.
        if (sent.length === 0) return existing;
        const set = [
          ...sent.map(({ field, column }) => ({ column, value: input?.[field] as SqlValue })),
          ...stamped(ctx, plan.stamps),
        ];
        ctx.sql.exec(
          `UPDATE ${quoted(plan.table)} SET ${set.map(({ column }) => `${quoted(column)} = ?`).join(', ')} ` +
            `WHERE ${quoted(plan.primaryKey)} = ?`,
          // The plan admits only string and number columns, and the host parsed the input against them.
          [...set.map(({ value }) => value), id],
        );
        const row = rowOrThrow(ctx, id);
        ctx.emit(eventOf(plan.emit, ref(id), row));
        return row;
      };

    case 'delete':
      return (ctx, input) => {
        const id = String(input?.[plan.idFrom]);
        rowOrThrow(ctx, id);
        ctx.sql.exec(`DELETE FROM ${quoted(plan.table)} WHERE ${quoted(plan.primaryKey)} = ?`, [id]);
        const result = { id, deleted: true };
        ctx.emit(eventOf(plan.emit, ref(id), result));
        return result;
      };

    case 'create':
      return (ctx, input) => {
        const parentId = plan.parent ? parentOrThrow(ctx, plan.parent, input) : undefined;
        const set = [
          ...(plan.parent ? [{ column: plan.parent.column, value: parentId as SqlValue }] : []),
          // A field the caller left out is NULL — the plan admits it only over a nullable column.
          ...plan.values.map(({ field, column }) => ({ column, value: (input?.[field] ?? null) as SqlValue })),
        ];
        // Idempotent on the natural key: the row that already holds it is the answer, unchanged.
        if (plan.key.length > 0) {
          const byKey = new Map(set.map(({ column, value }) => [column, value]));
          const existing = ctx.sql.query<Row>(
            `SELECT ${plan.columns.map(quoted).join(', ')} FROM ${quoted(plan.table)} WHERE ` +
              plan.key.map((column) => `${quoted(column)} IS ?`).join(' AND '),
            plan.key.map((column) => byKey.get(column) as SqlValue),
          )[0];
          if (existing) return existing;
        }
        const id = ulid();
        const row = [{ column: plan.primaryKey, value: id }, ...set, ...stamped(ctx, plan.stamps)];
        ctx.sql.exec(
          `INSERT INTO ${quoted(plan.table)} (${row.map(({ column }) => quoted(column)).join(', ')}) ` +
            `VALUES (${row.map(() => '?').join(', ')})`,
          row.map(({ value }) => value),
        );
        // The edge the permission walk follows from the new row to the parent it was checked on.
        if (plan.parent) ctx.link(ref(id), { entityType: plan.parent.entity, entityId: String(parentId) });
        const created = rowOrThrow(ctx, id);
        ctx.emit(eventOf(plan.emit, ref(id), created));
        return created;
      };
  }
}

/** The parent the input names, or `not_found` — answered after the check, so it probes nothing. */
function parentOrThrow(ctx: OperationContext, parent: DerivedParent, input: Input): string {
  const id = String(input?.[parent.idFrom]);
  const found = ctx.sql.query(
    `SELECT 1 AS found FROM ${quoted(parent.table)} WHERE ${quoted(parent.primaryKey)} = ?`,
    [id],
  )[0];
  if (!found) throw substratError('not_found', `${parent.entity} not found: ${id}`);
  return id;
}

/** Each stamp's value for this invocation: the time, or the caller. */
function stamped(ctx: OperationContext, stamps: readonly DerivedStamp[]): { column: string; value: SqlValue }[] {
  return stamps.map(({ column, kind }) => ({
    column,
    value: kind === 'createdAt' || kind === 'updatedAt' ? ctx.now() : String(ctx.principal),
  }));
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
