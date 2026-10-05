/**
 * The kernel-composed reads over archivable and trashable entities (#119), written once for
 * both adapters: the view predicate `ctx.page`/`ctx.search` add, and the two trashed readers.
 *
 * Kept apart from `entity-state.ts` because these need the list and search composers, and those
 * need the view predicate from there — one direction of import, not a cycle.
 */
import {
  listLimitOf,
  substratError,
  type EntityRef,
  type EntityStateName,
  type PermissionKey,
} from '@substrat-run/contracts';
import { entityStateWhere, stateColumnsOf, stateKeyOf, type EntityStatePlan, type StateCheck } from './entity-state.js';
import { cursorOf, listQuery, NotListable, type ListIndexPlan } from './list-index.js';
import type { OperationContext } from './scope-host.js';
import {
  NotSearchable,
  searchLimit,
  searchMatchExpression,
  searchQuery,
  type SearchHit,
  type SearchIndexPlan,
} from './search-index.js';

/**
 * Refuse the bin on the UNCHECKED readers. `ctx.page` and `ctx.search` check no permission, so
 * the trashed view is not theirs to serve — it reaches them as a string from the wire as easily
 * as from code, and must be refused there rather than answered.
 */
export function uncheckedView(verb: string, entityType: string, view: string | undefined): EntityStateName | undefined {
  if (view !== 'trashed') return view as EntityStateName | undefined;
  throw substratError(
    'validation_failed',
    `${verb}: the trash of '${entityType}' is read with ${verb === 'ctx.page' ? 'ctx.pageTrashed' : 'ctx.searchTrashed'}, ` +
      'which checks the declared trash key on every row',
    { errors: [{ path: 'view', message: 'trashed is not a view of this read' }] },
  );
}

/**
 * The `src`-aliased predicate a search over `entityType` adds for `view`, or `undefined` when
 * the entity declares no state (every row is active).
 */
export function searchStateWhere(
  statePlans: ReadonlyMap<string, EntityStatePlan>,
  entityType: string,
  view: EntityStateName | undefined,
): string | undefined {
  const plan = statePlans.get(entityType);
  return entityStateWhere(entityType, plan && stateColumnsOf(plan), uncheckedView('ctx.search', entityType, view), 'src');
}

/** What the trashed readers need from the adapter. */
export interface TrashedReadDeps {
  /** A read on the scope's own database, inside the operation. */
  query: (sql: string, params: readonly unknown[]) => Record<string, unknown>[];
  listPlans: ReadonlyMap<string, ListIndexPlan>;
  searchPlans: ReadonlyMap<string, SearchIndexPlan>;
  statePlans: ReadonlyMap<string, EntityStatePlan>;
  check: StateCheck;
  /** Rows one trashed page may read looking for visible ones — `TRASH_SCAN_BUDGET` unless a test narrows it. */
  scanBudget?: number;
}

/**
 * How many binned rows one `ctx.pageTrashed` call reads, at most, looking for rows the caller
 * may see. Each costs a permission check, and a Durable Object has a CPU budget per request, so
 * a bin full of other people's rows cannot be walked without bound inside one call.
 */
export const TRASH_SCAN_BUDGET = 2_000;

export type TrashedReads = Pick<OperationContext, 'pageTrashed' | 'searchTrashed'>;

/**
 * Keep the rows of a trashed read the caller may see in the bin.
 *
 * The declared trash key is checked per row, inside the kernel, so a handler cannot forget it:
 * a member who holds the key on their own lists sees their own bin and nobody else's. Per row
 * because the key is usually entity-narrowed; a scope-wide holder passes every row and pays one
 * cheap check each.
 */
async function keepVisible<T>(
  check: StateCheck,
  key: PermissionKey,
  entityType: string,
  rows: readonly T[],
  idOf: (row: T) => string,
): Promise<T[]> {
  const kept: T[] = [];
  for (const row of rows) {
    const entity: EntityRef = { entityType, entityId: idOf(row) };
    if ((await check(key, entity)).allowed) kept.push(row);
  }
  return kept;
}

export function createTrashedReads(deps: TrashedReadDeps): TrashedReads {
  return {
    /**
     * The bin, walked so that **no position of a row the caller may not see ever leaves the
     * kernel.** A cursor is a row's sort value and id, so minting one from a refused row would
     * hand the caller that row's id and timestamp — the very thing the per-row check withholds.
     *
     * So the walk runs internally past refused rows until it has `limit` visible ones or reaches
     * the end, and the cursor is minted from the last VISIBLE row (null at the end). Past
     * `TRASH_SCAN_BUDGET` rows it stops: with a visible row in hand it returns what it found,
     * continued from that row; with none it refuses, because "empty, and here is where to go
     * on" is the leak and "empty, and that is the end" would be a lie.
     */
    async pageTrashed(entityType, params) {
      const { key } = stateKeyOf(deps.statePlans, 'ctx.pageTrashed', entityType, 'trash');
      const plan = deps.listPlans.get(entityType);
      if (!plan) throw new NotListable(entityType);
      if ((params as { total?: boolean }).total) {
        throw substratError(
          'validation_failed',
          'ctx.pageTrashed: a trashed page carries no total — a count over rows the caller may not see would disclose them',
        );
      }
      const limit = listLimitOf(params.limit);
      const budget = deps.scanBudget ?? TRASH_SCAN_BUDGET;
      const kept: Record<string, unknown>[] = [];
      let cursor = params.cursor;
      let scanned = 0;
      let sortColumn = '';
      let order: 'asc' | 'desc' = 'asc';
      for (;;) {
        const batch = Math.min(limit, budget - scanned);
        const q = listQuery(plan, {
          limit: batch,
          sort: params.sort,
          order: params.order,
          cursor,
          filters: params.filters,
          view: 'trashed',
        });
        ({ sortColumn, order } = q);
        const rows = deps.query(q.sql, q.params);
        for (const row of rows) {
          scanned += 1;
          const entity: EntityRef = { entityType, entityId: String(row[plan.idColumn]) };
          if (!(await deps.check(key, entity)).allowed) continue;
          kept.push(row);
          if (kept.length === limit) {
            return { entries: kept as never[], nextCursor: cursorOf(row, sortColumn, plan.idColumn, order) };
          }
        }
        // A short batch is the end of the bin: nothing after it, so no cursor at all.
        if (rows.length < batch) return { entries: kept as never[], nextCursor: null };
        // Internal only — never returned while it points at a refused row.
        cursor = cursorOf(rows[rows.length - 1]!, sortColumn, plan.idColumn, order);
        if (scanned >= budget) break;
      }
      const last = kept[kept.length - 1];
      if (last) return { entries: kept as never[], nextCursor: cursorOf(last, sortColumn, plan.idColumn, order) };
      throw substratError(
        'precondition_failed',
        `ctx.pageTrashed: read ${scanned} binned '${entityType}' rows without finding one this caller may see — ` +
          'narrow the walk with a declared filter',
      );
    },

    async searchTrashed(entityType, term, options) {
      const { plan: state, key } = stateKeyOf(deps.statePlans, 'ctx.searchTrashed', entityType, 'trash');
      const plan = deps.searchPlans.get(entityType);
      if (!plan) throw new NotSearchable(entityType);
      const q = searchQuery(
        plan,
        searchMatchExpression(term, plan.tokenizer),
        searchLimit(options?.limit),
        entityStateWhere(entityType, stateColumnsOf(state), 'trashed', 'src'),
      );
      const hits = (deps.query(q.sql, q.params) as { id: string; rank: number }[]).map(
        (row): SearchHit => ({ entityType, id: row.id, rank: row.rank }),
      );
      return keepVisible(deps.check, key, entityType, hits, (hit) => hit.id);
    },
  };
}
