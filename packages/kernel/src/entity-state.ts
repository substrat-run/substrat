/**
 * Entity archive and trash (#119): the kernel half, written once — both adapters hand
 * `createEntityStateVerbs` the same things, the way `createEntityEdgeVerbs` is shared.
 *
 * ## What the kernel owns, and what it leaves to the vertical
 *
 * | Kernel | Vertical |
 * |---|---|
 * | The two columns on the entity's table, added by a derived migration | Which entities declare `archive` / `trash`, and the keys |
 * | The transitions, their refusals, and the event each one emits | The operations that call the verbs, and their routes |
 * | The declared key, re-checked on the entity by every verb and every trashed read | What an archived row looks like on a screen |
 * | `ctx.page` / `ctx.search` leaving archived and trashed rows out by default | Its own hand-written `SELECT`s — see the gap below |
 *
 * ## The state is two columns
 *
 * `_substrat_archived_at` and `_substrat_trashed_at`, each an ISO instant or NULL. Apart, not
 * one enum, so a trash never forgets an archive: `restore` clears the trash and leaves the
 * archive, and an archived row that went to the bin comes back archived. The visible state is
 * derived (contracts `entity-state.ts`): trashed, else archived, else active.
 *
 * Module code cannot write either column: `ctx.sql` refuses a write naming a `_substrat_*`
 * column (`spine-guard.ts`), so the only way into or out of the trash is a verb that checks
 * the key and emits the event. It can READ them, which is how a vertical's own `SELECT` keeps
 * archived rows out of a screen `ctx.page` does not compose.
 *
 * ## The gap, stated
 *
 * The kernel filters the reads it composes — `ctx.page` and `ctx.search` — and nothing else.
 * A handler's own `SELECT … FROM todo_lists WHERE id = ?` sees an archived or trashed row
 * exactly as before. That is the honest limit of a kernel that does not parse module SQL:
 * a get-by-id asks `ctx.entityState(ref)` and decides, and a hand-written list adds the
 * predicate itself (`entityStateWhere`).
 *
 * ## Trash is not erasure, and not tenant deletion
 *
 * Trash keeps the row and every event about it. Subject erasure (#37) reaches a trashed row
 * exactly as it reaches any other, because the row never moved tables; a tenant's deletion
 * (#36) removes it with everything else. Nothing here extends a retention or shortens one.
 */
import {
  ARCHIVED_AT_COLUMN,
  ENTITY_ARCHIVED,
  ENTITY_RESTORED,
  ENTITY_TRASHED,
  ENTITY_UNARCHIVED,
  TRASHED_AT_COLUMN,
  entityStateChangedPayload,
  substratError,
  type Decision,
  type DomainEventInput,
  type EntityRef,
  type EntityStateDeclaration,
  type EntityStateName,
  type EntityStateView,
  type Instant,
  type PermissionKey,
} from '@substrat-run/contracts';
import { assertAllowed } from './permission-checker.js';
import type { ScopedSql, SqlMigration } from './scope-host.js';

/** A resolved declaration: everything the DDL, the reads and the verbs need. */
export interface EntityStatePlan {
  readonly moduleId: string;
  readonly entityType: string;
  readonly table: string;
  readonly idColumn: string;
  /** Present when the entity can be archived. */
  readonly archivePermission?: PermissionKey;
  /** Present when the entity can be trashed. */
  readonly trashPermission?: PermissionKey;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdentifier(kind: string, value: string, where: string): string {
  if (!IDENTIFIER.test(value)) {
    throw new Error(`entity state: ${where} names ${kind} '${value}', which is not a plain SQL identifier`);
  }
  return value;
}

/**
 * Resolve one module's declarations. Refuses rather than skips, for `searchIndexPlans`'s
 * reason: a declaration the author believes is live that silently is not leaves a trashed
 * row in every list with no error anywhere.
 */
export function entityStatePlans(
  moduleId: string,
  declarations: readonly EntityStateDeclaration[] | undefined,
): EntityStatePlan[] {
  if (!declarations?.length) return [];
  const plans: EntityStatePlan[] = [];
  const seen = new Set<string>();
  for (const decl of declarations) {
    const where = `${moduleId} entityStates['${decl.entityType}']`;
    if (seen.has(decl.entityType)) throw new Error(`entity state: ${where} is declared twice`);
    seen.add(decl.entityType);
    if (!decl.table) {
      throw new Error(
        `entity state: ${where} carries no table — declare \`archive\`/\`trash\` on the entity and ` +
          'spread `manifestEntities()`, so the entity registry supplies it',
      );
    }
    if (!decl.archivePermission && !decl.trashPermission) {
      throw new Error(`entity state: ${where} declares neither an archive nor a trash permission`);
    }
    plans.push({
      moduleId,
      entityType: decl.entityType,
      table: assertIdentifier('a table', decl.table, where),
      idColumn: assertIdentifier('an id column', decl.idColumn ?? 'id', where),
      ...(decl.archivePermission ? { archivePermission: decl.archivePermission } : {}),
      ...(decl.trashPermission ? { trashPermission: decl.trashPermission } : {}),
    });
  }
  return plans;
}

/**
 * The migrations that add the columns — one per column, so declaring `trash` on an entity
 * that already declared `archive` adds one column and re-runs nothing.
 *
 * **The version is the declaration**, as for search and list indexes. Unlike theirs, this DDL
 * is not drop-then-create: a column holds the state, and dropping it would un-trash every row.
 * So it runs once per column, ever. Withdrawing a declaration leaves the column where it is,
 * holding what it held; re-declaring it finds the migration already applied.
 *
 * Applied after the module's own migrations (the table must exist) and before its list
 * indexes (their partial `WHERE` names these columns) — `moduleMigrations` writes that order.
 */
export function entityStateMigrations(
  moduleId: string,
  declarations: readonly EntityStateDeclaration[] | undefined,
): SqlMigration[] {
  const out: SqlMigration[] = [];
  for (const plan of entityStatePlans(moduleId, declarations)) {
    if (plan.archivePermission) {
      out.push({
        version: `state/${plan.entityType}:archive`,
        sql: `ALTER TABLE ${plan.table} ADD COLUMN ${ARCHIVED_AT_COLUMN} TEXT;`,
      });
    }
    if (plan.trashPermission) {
      out.push({
        version: `state/${plan.entityType}:trash`,
        sql: `ALTER TABLE ${plan.table} ADD COLUMN ${TRASHED_AT_COLUMN} TEXT;`,
      });
    }
  }
  return out;
}

/**
 * Index the plans by entity type for a whole scope. Two modules declaring one entity type is
 * refused: the table is one module's, and two answers to "who may trash it" is no answer.
 */
export function statePlansByEntityType(
  modules: readonly { readonly id: string; readonly entityStates?: readonly EntityStateDeclaration[] }[],
): Map<string, EntityStatePlan> {
  const byType = new Map<string, EntityStatePlan>();
  for (const mod of modules) addStatePlans(byType, mod.id, mod.entityStates);
  return byType;
}

/**
 * Add one module's plans to a registry, refusing a second declaration of a type — and a key
 * the module does not declare. The entity is the module's, so its keys are too: a key nobody
 * declared reaches no role, no grant shape and no `PERMISSIONS.md`, and would make the verb
 * look gated while nobody could ever pass it.
 */
export function addStatePlans(
  byType: Map<string, EntityStatePlan>,
  moduleId: string,
  declarations: readonly EntityStateDeclaration[] | undefined,
  declaredKeys?: readonly { readonly key: string }[],
): void {
  for (const plan of entityStatePlans(moduleId, declarations)) {
    if (declaredKeys) {
      for (const key of [plan.archivePermission, plan.trashPermission]) {
        if (key && !declaredKeys.some((p) => p.key === key)) {
          throw new Error(
            `entity state: ${moduleId} gates '${plan.entityType}' on '${key}', which it does not declare in \`permissions\``,
          );
        }
      }
    }
    const existing = byType.get(plan.entityType);
    if (existing) {
      throw new Error(
        `entity state: '${plan.entityType}' is declared archivable/trashable by both ` +
          `'${existing.moduleId}' and '${plan.moduleId}' — one entity type, one owner`,
      );
    }
    byType.set(plan.entityType, plan);
  }
}

/** The columns a plan has, for code that only needs to know which views exist. */
export interface StateColumns {
  readonly archive: boolean;
  readonly trash: boolean;
}

export const stateColumnsOf = (plan: EntityStatePlan): StateColumns => ({
  archive: plan.archivePermission !== undefined,
  trash: plan.trashPermission !== undefined,
});

/** The views an entity with these columns has — `active` always, then one per column. */
export function viewsOf(columns: StateColumns): EntityStateView[] {
  return ['active', ...(columns.archive ? (['archived'] as const) : []), ...(columns.trash ? (['trashed'] as const) : [])];
}

/**
 * The predicate selecting one view's rows, over bare column names or `alias.`-qualified ones.
 *
 * **Spelled one way, everywhere.** A partial index is used only when the query's `WHERE`
 * contains the index's own terms, so the list index DDL and the list query both come from
 * here — a reworded copy would plan a scan in production and pass every test.
 *
 * Refuses a view the entity does not have: asking an entity with no trash for its trashed
 * rows is a wiring mistake, and an empty page would read as an empty bin.
 */
export function entityStateWhere(
  entityType: string,
  columns: StateColumns,
  view: EntityStateView,
  alias?: string,
): string {
  const col = (name: string) => (alias ? `${alias}.${name}` : name);
  if (view === 'archived' && !columns.archive) throw viewNotDeclared(entityType, view);
  if (view === 'trashed' && !columns.trash) throw viewNotDeclared(entityType, view);
  const terms: string[] = [];
  if (view === 'trashed') {
    terms.push(`${col(TRASHED_AT_COLUMN)} IS NOT NULL`);
  } else {
    if (columns.archive) terms.push(`${col(ARCHIVED_AT_COLUMN)} IS ${view === 'archived' ? 'NOT ' : ''}NULL`);
    if (columns.trash) terms.push(`${col(TRASHED_AT_COLUMN)} IS NULL`);
  }
  return terms.join(' AND ');
}

function viewNotDeclared(entityType: string, view: EntityStateView): Error {
  return substratError(
    'validation_failed',
    `'${entityType}' has no ${view} view — it declares no ${view === 'archived' ? 'archive' : 'trash'}`,
    { errors: [{ path: 'view', message: `not declared for '${entityType}'` }] },
  );
}

/** Refuse a non-active view of an entity that declares no state at all. */
export function assertActiveOnly(entityType: string, view: EntityStateView | undefined): void {
  if (view === undefined || view === 'active') return;
  throw viewNotDeclared(entityType, view);
}

/** The two columns as one row holds them. */
interface StateRow {
  readonly archived_at: string | null;
  readonly trashed_at: string | null;
}

const stateOf = (row: StateRow): EntityStateName =>
  row.trashed_at !== null ? 'trashed' : row.archived_at !== null ? 'archived' : 'active';

/** One row's state, or `null` when the row does not exist. */
export function readEntityState(sql: ScopedSql, plan: EntityStatePlan, entityId: string): EntityStateName | null {
  const columns = stateColumnsOf(plan);
  const row = sql.query<StateRow>(
    `SELECT ${columns.archive ? ARCHIVED_AT_COLUMN : 'NULL'} AS archived_at, ` +
      `${columns.trash ? TRASHED_AT_COLUMN : 'NULL'} AS trashed_at ` +
      `FROM ${plan.table} WHERE ${plan.idColumn} = ?`,
    [entityId],
  )[0];
  return row ? stateOf(row) : null;
}

/** What the verbs need from the adapter. */
export interface EntityStateDeps {
  /** RAW access inside the operation's own transaction — the guarded `ctx.sql` refuses these columns. */
  sql: ScopedSql;
  /** entity type → its plan, for every registered module. */
  plans: ReadonlyMap<string, EntityStatePlan>;
  /** The operation's instant — what each column is stamped with. */
  now: Instant;
  /** The operation's own check, so a pass is recorded as one of its authorizations (K-34). */
  check: (permission: PermissionKey, entity: EntityRef) => Promise<Decision>;
  /** `ctx.emit`'s kernel writer — stamps the actor, the authorization chain and the operation. */
  emit: (event: DomainEventInput) => void;
  /** K-42's read-only refusal, for the effecting verbs. */
  assertWrites: (verb: string) => void;
}

/** The verbs, as `OperationContext` carries them. */
export interface EntityStateVerbs {
  archive(entity: EntityRef): Promise<void>;
  unarchive(entity: EntityRef): Promise<void>;
  trash(entity: EntityRef): Promise<void>;
  restore(entity: EntityRef): Promise<void>;
  entityState(entity: EntityRef): EntityStateName | null;
}

type Move = {
  readonly verb: string;
  readonly key: 'archivePermission' | 'trashPermission';
  readonly from: readonly EntityStateName[];
  readonly column: string;
  readonly set: boolean;
  readonly type: string;
};

const MOVES = {
  archive: {
    verb: 'ctx.archive',
    key: 'archivePermission',
    from: ['active'],
    column: ARCHIVED_AT_COLUMN,
    set: true,
    type: ENTITY_ARCHIVED,
  },
  unarchive: {
    verb: 'ctx.unarchive',
    key: 'archivePermission',
    from: ['archived'],
    column: ARCHIVED_AT_COLUMN,
    set: false,
    type: ENTITY_UNARCHIVED,
  },
  // Archived rows may be trashed: "delete this old thing" is the commonest reason to open an
  // archive at all. The archive survives the trip, which is what `restore` relies on.
  trash: {
    verb: 'ctx.trash',
    key: 'trashPermission',
    from: ['active', 'archived'],
    column: TRASHED_AT_COLUMN,
    set: true,
    type: ENTITY_TRASHED,
  },
  restore: {
    verb: 'ctx.restore',
    key: 'trashPermission',
    from: ['trashed'],
    column: TRASHED_AT_COLUMN,
    set: false,
    type: ENTITY_RESTORED,
  },
} as const satisfies Record<string, Move>;

export function createEntityStateVerbs(deps: EntityStateDeps): EntityStateVerbs {
  const planFor = (verb: string, entity: EntityRef): EntityStatePlan => {
    const plan = deps.plans.get(entity.entityType);
    if (!plan) {
      throw substratError(
        'validation_failed',
        `${verb}: '${entity.entityType}' declares no archive or trash — declare one on the entity`,
      );
    }
    return plan;
  };

  const move = async (m: Move, entity: EntityRef): Promise<void> => {
    deps.assertWrites(m.verb);
    const plan = planFor(m.verb, entity);
    const key = plan[m.key];
    if (!key) {
      throw substratError(
        'validation_failed',
        `${m.verb}: '${entity.entityType}' declares no ${m.key === 'archivePermission' ? 'archive' : 'trash'}`,
      );
    }
    // The DECLARED key, on THIS entity, before anything about the row is read: whether it
    // exists is not something a caller without the key gets to learn.
    assertAllowed(await deps.check(key, entity));
    const from = readEntityState(deps.sql, plan, entity.entityId);
    if (from === null) {
      throw substratError('not_found', `${m.verb}: ${entity.entityType}:${entity.entityId} does not exist`);
    }
    if (!m.from.includes(from)) {
      throw substratError(
        'conflict',
        `${m.verb}: ${entity.entityType}:${entity.entityId} is ${from} — ` +
          `only ${m.from.join(' or ')} can be moved this way`,
        { reason: 'invalid_transition' },
      );
    }
    deps.sql.exec(`UPDATE ${plan.table} SET ${m.column} = ? WHERE ${plan.idColumn} = ?`, [
      m.set ? deps.now : null,
      entity.entityId,
    ]);
    const to = readEntityState(deps.sql, plan, entity.entityId) as EntityStateName;
    const payload = entityStateChangedPayload.parse({ entity, from, to }); // strips extra keys
    deps.emit({ type: m.type, schemaVersion: 1, entity: payload.entity, piiClass: 'none', payload });
  };

  return {
    archive: (entity) => move(MOVES.archive, entity),
    unarchive: (entity) => move(MOVES.unarchive, entity),
    trash: (entity) => move(MOVES.trash, entity),
    restore: (entity) => move(MOVES.restore, entity),
    entityState: (entity) => readEntityState(deps.sql, planFor('ctx.entityState', entity), entity.entityId),
  };
}

/**
 * Keep the rows of a trashed read the caller may see in the bin (#119).
 *
 * The trashed readers check the DECLARED trash key per row, inside the kernel, so a handler
 * cannot forget it: a member who holds the key on their own lists sees their own bin and
 * nobody else's. Per row because the key is usually entity-narrowed; a scope-wide holder
 * passes every row and pays one cheap check each.
 */
export async function keepTrashedVisible<T>(
  plan: EntityStatePlan,
  rows: readonly T[],
  idOf: (row: T) => string,
  check: (permission: PermissionKey, entity: EntityRef) => Promise<Decision>,
): Promise<T[]> {
  const key = plan.trashPermission;
  if (!key) throw viewNotDeclared(plan.entityType, 'trashed');
  const kept: T[] = [];
  for (const row of rows) {
    const decision = await check(key, { entityType: plan.entityType, entityId: idOf(row) });
    if (decision.allowed) kept.push(row);
  }
  return kept;
}
