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
  type Decision,
  type EntityRef,
  type EntityStateView,
  type Page,
  type PermissionKey,
} from '@substrat-run/contracts';
import { assertActiveOnly, entityStateWhere, keepTrashedVisible, stateColumnsOf, type EntityStatePlan } from './entity-state.js';
import { cursorOf, listQuery, NotListable, type ListIndexPlan } from './list-index.js';
import type { PageParams } from './scope-host.js';
import {
  NotSearchable,
  searchLimit,
  searchMatchExpression,
  searchQuery,
  type SearchHit,
  type SearchIndexPlan,
  type SearchOptions,
} from './search-index.js';

/**
 * Refuse the bin on the UNCHECKED readers. `ctx.page` and `ctx.search` check no permission, so
 * the trashed view is not theirs to serve — it reaches them as a string from the wire as easily
 * as from code, and must be refused there rather than answered.
 */
export function uncheckedView(verb: string, entityType: string, view: string | undefined): EntityStateView | undefined {
  if (view !== 'trashed') return view as EntityStateView | undefined;
  throw substratError(
    'validation_failed',
    `${verb}: the trash of '${entityType}' is read with ${verb === 'ctx.page' ? 'ctx.pageTrashed' : 'ctx.searchTrashed'}, ` +
      'which checks the declared trash key on every row',
    { errors: [{ path: 'view', message: 'trashed is not a view of this read' }] },
  );
}

/**
 * The `src`-aliased predicate a search over `entityType` adds for `view`, or `undefined` when
 * the entity declares no state (every row is active). A non-active view of such an entity is
 * refused rather than answered empty.
 */
export function searchStateWhere(
  statePlans: ReadonlyMap<string, EntityStatePlan>,
  entityType: string,
  view: EntityStateView | undefined,
): string | undefined {
  const checked = uncheckedView('ctx.search', entityType, view);
  const plan = statePlans.get(entityType);
  if (!plan) {
    assertActiveOnly(entityType, checked);
    return undefined;
  }
  return entityStateWhere(entityType, stateColumnsOf(plan), checked ?? 'active', 'src');
}

/** What the trashed readers need from the adapter. */
export interface TrashedReadDeps {
  /** A read on the scope's own database, inside the operation. */
  query: (sql: string, params: readonly unknown[]) => Record<string, unknown>[];
  listPlans: ReadonlyMap<string, ListIndexPlan>;
  searchPlans: ReadonlyMap<string, SearchIndexPlan>;
  statePlans: ReadonlyMap<string, EntityStatePlan>;
  /** The operation's own check — each per-row pass is one of its authorizations (K-34). */
  check: (permission: PermissionKey, entity: EntityRef) => Promise<Decision>;
}

export interface TrashedReads {
  pageTrashed<T>(entityType: string, params: Omit<PageParams, 'view' | 'total'>): Promise<Page<T>>;
  searchTrashed(entityType: string, term: string, options?: Omit<SearchOptions, 'view'>): Promise<SearchHit[]>;
}

export function createTrashedReads(deps: TrashedReadDeps): TrashedReads {
  const trashPlanOf = (verb: string, entityType: string): EntityStatePlan => {
    const plan = deps.statePlans.get(entityType);
    if (!plan?.trashPermission) {
      throw substratError('validation_failed', `${verb}: '${entityType}' declares no trash`, {
        errors: [{ path: 'entityType', message: `'${entityType}' declares no trash` }],
      });
    }
    return plan;
  };

  return {
    async pageTrashed<T>(entityType: string, params: Omit<PageParams, 'view' | 'total'>): Promise<Page<T>> {
      const state = trashPlanOf('ctx.pageTrashed', entityType);
      const plan = deps.listPlans.get(entityType);
      if (!plan) throw new NotListable(entityType);
      if ((params as PageParams).total) {
        throw substratError(
          'validation_failed',
          'ctx.pageTrashed: a trashed page carries no total — a count over rows the caller may not see would disclose them',
        );
      }
      const limit = listLimitOf(params.limit);
      const q = listQuery(plan, {
        limit,
        sort: params.sort,
        order: params.order,
        cursor: params.cursor,
        filters: params.filters,
        view: 'trashed',
      });
      const rows = deps.query(q.sql, q.params);
      // The cursor comes from the LAST ROW READ, kept or not: a page whose every row was
      // refused still moves the walk on, rather than ending it as though the bin were empty.
      const last = rows.length >= limit ? rows[rows.length - 1] : undefined;
      const nextCursor = last === undefined ? null : cursorOf(last, q.sortColumn, plan.idColumn, q.order);
      const kept = await keepTrashedVisible(state, rows, (row) => String(row[plan.idColumn]), deps.check);
      return { entries: kept as T[], nextCursor };
    },

    async searchTrashed(entityType: string, term: string, options?: Omit<SearchOptions, 'view'>): Promise<SearchHit[]> {
      const state = trashPlanOf('ctx.searchTrashed', entityType);
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
      return keepTrashedVisible(state, hits, (hit) => hit.id, deps.check);
    },
  };
}
