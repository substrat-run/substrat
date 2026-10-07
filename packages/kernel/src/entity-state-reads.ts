/**
 * The kernel-composed reads over archivable and trashable entities (#119), written once for
 * both adapters: the view predicate `ctx.page`/`ctx.search` add, and the two trashed readers.
 *
 * Kept apart from `entity-state.ts` because these need the list and search composers, and those
 * need the view predicate from there — one direction of import, not a cycle.
 */
import {
  pageOf,
  pageVisible,
  substratError,
  VISIBLE_SCAN_BUDGET,
  type Page,
  type EntityRef,
  type EntityStateName,
  type PermissionKey,
} from '@substrat-run/contracts';
import { entityStateWhere, stateColumnsOf, stateKeyOf, type EntityStatePlan, type StateCheck } from './entity-state.js';
import { cursorOf, listQuery, NotListable, type ListIndexPlan } from './list-index.js';
import type { OperationContext, PageParams } from './scope-host.js';
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
  continuation?: (entityType: string, params: PageParams) => ReturnType<OperationContext['pageContinuation']>;
}

/** How many binned rows one `ctx.pageTrashed` call reads, at most — `VISIBLE_SCAN_BUDGET`. */
export const TRASH_SCAN_BUDGET = VISIBLE_SCAN_BUDGET;

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
     * The bin uses `pageVisible` with the declared trash key as its per-row check.
     * A budget stop carries a sealed continuation of the last examined row, including
     * when no row passed the check. No plain position leaves the kernel (#2074, K-45).
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
      return pageVisible(
        ({ limit, cursor, rowCursors }) => {
          const q = listQuery(plan, {
            limit,
            sort: params.sort,
            order: params.order,
            cursor,
            filters: params.filters,
            view: 'trashed',
          });
          return pageOf(
            deps.query(q.sql, q.params),
            limit,
            (row) => cursorOf(row, q.sortColumn, plan.idColumn, q.order, 'trashed'),
            rowCursors,
          );
        },
        params,
        async (row) => (await deps.check(key, { entityType, entityId: String(row[plan.idColumn]) })).allowed,
        {
          scanBudget: deps.scanBudget ?? TRASH_SCAN_BUDGET,
          continuation: deps.continuation?.(entityType, params),
        },
      ) as Promise<Page<never>>;
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
