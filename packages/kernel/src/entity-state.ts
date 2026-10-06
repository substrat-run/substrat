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
  type DomainEventInput,
  type EntityRef,
  type EntityStateDeclaration,
  type EntityStateName,
  type Instant,
  type PermissionKey,
} from '@substrat-run/contracts';
import { assertAllowed } from './permission-checker.js';
import type { OperationContext, ScopedSql, SqlMigration } from './scope-host.js';
import type { DerivedObject } from './derived-object.js';
import { assertSqlIdentifier } from './sql-identifier.js';

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

/** The operation's own check — a pass is recorded as one of its authorizations (K-34). */
export type StateCheck = OperationContext['check'];

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
      table: assertSqlIdentifier('entity state', 'a table', decl.table, where),
      idColumn: assertSqlIdentifier('entity state', 'an id column', decl.idColumn ?? 'id', where),
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
    for (const { version, column } of stateColumnVersionsOf(plan)) {
      out.push({ version, sql: `ALTER TABLE ${plan.table} ADD COLUMN ${column} TEXT;` });
    }
    // After the columns they name.
    out.push({ version: entityStateGuardVersion(plan), sql: entityStateTriggerDdl(plan) });
  }
  return out;
}

/** The column migrations' versions, and the column each adds — what the journal says a table holds. */
export const stateColumnVersionsOf = (plan: EntityStatePlan): { version: string; column: string }[] => [
  ...(plan.archivePermission ? [{ version: `state/${plan.entityType}:archive`, column: ARCHIVED_AT_COLUMN }] : []),
  ...(plan.trashPermission ? [{ version: `state/${plan.entityType}:trash`, column: TRASHED_AT_COLUMN }] : []),
];

/**
 * The guard triggers' version. By which columns they guard, so declaring a trash on an
 * archivable entity rebuilds them to guard both.
 */
export const entityStateGuardVersion = (plan: EntityStatePlan): string => {
  const { archive, trash } = stateColumnsOf(plan);
  return `state/${plan.entityType}:guard:${[...(archive ? ['archive'] : []), ...(trash ? ['trash'] : [])].join('+')}`;
};

/** The prefix of every trigger this module derives — kernel-owned, so the reserved one. */
export const ENTITY_STATE_TRIGGER_PREFIX = '_substrat_state_';

/**
 * The kernel's authorization for ONE move (#119, Codex r2): the row `ctx.archive` & co. write
 * just before their `UPDATE` and delete just after it, in the same transaction. The update
 * trigger below refuses any change to the columns that has no such row — so the only writer the
 * columns admit is the one that can write a `_substrat_*` TABLE, which `ctx.sql` refuses by name
 * (a far simpler reading than finding an assignment target in an expression).
 *
 * Never holds a row between operations: written and removed inside one move, and a move that
 * throws rolls back with its operation. Shared by both adapters' `KERNEL_DDL`, like the other
 * kernel-owned spine tables, so the two cannot part company.
 */
export const ENTITY_STATE_MOVES_TABLE = '_substrat_state_moves';
export const ENTITY_STATE_MOVES_DDL = `
  CREATE TABLE IF NOT EXISTS _substrat_state_moves (
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    PRIMARY KEY (entity_type, entity_id)
  );
`;

/** A string literal for SQL text: the entity type is a declaration, still quoted rather than trusted. */
const literal = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/**
 * The invariant below the column guard, as two triggers on the entity's table.
 *
 * `ctx.sql` refuses the writes that would set the columns (`assertNoReservedColumnWrite`), but
 * that is a reading of SQL text, and a reading can miss a form — it did, twice. These hold
 * whatever the text says:
 *
 * - **born** — `BEFORE INSERT`: a row is never inserted archived or trashed. Every row enters
 *   active.
 * - **moved** — `BEFORE UPDATE OF` the columns: a change to either aborts unless the kernel's
 *   authorization row for this entity exists (`ENTITY_STATE_MOVES_TABLE`), which only a move
 *   writes. An `UPDATE` that does not name the columns does not fire it.
 *
 * Drop-then-create, like the search triggers, and re-run after a dump load: a load drops the
 * table and with it the triggers, then inserts the rows first — a restored binned row is
 * legitimately born trashed, so the triggers are put back only after them.
 */
export function entityStateTriggerDdl(plan: EntityStatePlan): string {
  return entityStateTriggerObjects(plan)
    .flatMap((t) => [`DROP TRIGGER IF EXISTS ${t.name};`, `${t.sql};`])
    .join('\n');
}

/** The two guard triggers `entityStateTriggerDdl` creates, each with its CREATE statement. */
export function entityStateTriggerObjects(plan: EntityStatePlan): DerivedObject[] {
  const born = `${ENTITY_STATE_TRIGGER_PREFIX}${plan.table}_born`;
  const moved = `${ENTITY_STATE_TRIGGER_PREFIX}${plan.table}_moved`;
  const columns = stateColumnVersionsOf(plan).map((c) => c.column);
  const trigger = (name: string, lines: string[]): DerivedObject => ({ name, type: 'trigger', table: plan.table, sql: lines.join('\n') });
  return [
    trigger(born, [
      `CREATE TRIGGER ${born} BEFORE INSERT ON ${plan.table} WHEN ${columns.map((c) => `NEW.${c} IS NOT NULL`).join(' OR ')} BEGIN`,
      `  SELECT RAISE(ABORT, 'a row is never inserted archived or trashed - ctx.archive and ctx.trash move it (#119)');`,
      `END`,
    ]),
    trigger(moved, [
      `CREATE TRIGGER ${moved} BEFORE UPDATE OF ${columns.join(', ')} ON ${plan.table}`,
      `WHEN NOT EXISTS (SELECT 1 FROM ${ENTITY_STATE_MOVES_TABLE} WHERE entity_type = ${literal(plan.entityType)} AND entity_id = OLD.${plan.idColumn}) BEGIN`,
      `  SELECT RAISE(ABORT, 'archive and trash state moves only through ctx.archive, ctx.trash and ctx.restore (#119)');`,
      `END`,
    ]),
  ];
}

/**
 * Add one module's plans to a scope's registry, refusing a second declaration of a type — the
 * table is one module's, and two answers to "who may trash it" is no answer — and a key the
 * module does not declare. The entity is the module's, so its keys are too: a key nobody
 * declared reaches no role, no grant shape and no `PERMISSIONS.md`, and would make the verb
 * look gated while nobody could ever pass it.
 */
export function addStatePlans(
  byType: Map<string, EntityStatePlan>,
  moduleId: string,
  declarations: readonly EntityStateDeclaration[] | undefined,
  declaredKeys: readonly { readonly key: string }[],
): void {
  for (const plan of entityStatePlans(moduleId, declarations)) {
    for (const key of [plan.archivePermission, plan.trashPermission]) {
      if (key && !declaredKeys.some((p) => p.key === key)) {
        throw new Error(
          `entity state: ${moduleId} gates '${plan.entityType}' on '${key}', which it does not declare in \`permissions\``,
        );
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

/** The tables whose rows carry the columns, lowercased as SQLite resolves a name — `guardSpine`'s input. */
export const statefulTablesOf = (plans: ReadonlyMap<string, EntityStatePlan>): ReadonlySet<string> =>
  new Set([...plans.values()].map((p) => p.table.toLowerCase()));

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
export function viewsOf(columns: StateColumns): EntityStateName[] {
  return ['active', ...(columns.archive ? (['archived'] as const) : []), ...(columns.trash ? (['trashed'] as const) : [])];
}

/**
 * The predicate selecting one view's rows, over bare column names or `alias.`-qualified ones.
 *
 * **Spelled one way, everywhere.** A partial index is used only when the query's `WHERE`
 * contains the index's own terms, so the list index DDL and the list query both come from
 * here — a reworded copy would plan a scan in production and pass every test.
 *
 * `columns` absent is an entity that declares no state: every row is active, so there is no
 * predicate. A view the entity does not have is refused rather than answered empty — asking
 * an entity with no trash for its trashed rows is a wiring mistake, and an empty page would
 * read as an empty bin.
 */
export function entityStateWhere(
  entityType: string,
  columns: StateColumns,
  view: EntityStateName,
  alias?: string,
): string;
export function entityStateWhere(
  entityType: string,
  columns: StateColumns | undefined,
  view: EntityStateName | undefined,
  alias?: string,
): string | undefined;
export function entityStateWhere(
  entityType: string,
  columns: StateColumns | undefined,
  view: EntityStateName | undefined,
  alias?: string,
): string | undefined {
  const asked = view ?? 'active';
  if ((asked === 'archived' && !columns?.archive) || (asked === 'trashed' && !columns?.trash)) {
    throw substratError(
      'validation_failed',
      `'${entityType}' has no ${asked} view — it declares no ${asked === 'archived' ? 'archive' : 'trash'}`,
      { errors: [{ path: 'view', message: `not declared for '${entityType}'` }] },
    );
  }
  if (!columns) return undefined;
  const col = (name: string) => (alias ? `${alias}.${name}` : name);
  if (asked === 'trashed') return `${col(TRASHED_AT_COLUMN)} IS NOT NULL`;
  const terms: string[] = [];
  if (columns.archive) terms.push(`${col(ARCHIVED_AT_COLUMN)} IS ${asked === 'archived' ? 'NOT ' : ''}NULL`);
  if (columns.trash) terms.push(`${col(TRASHED_AT_COLUMN)} IS NULL`);
  return terms.join(' AND ');
}

/** The two columns as one row holds them. */
interface StateRow {
  readonly archived_at: string | null;
  readonly trashed_at: string | null;
}

const stateOf = (row: StateRow): EntityStateName =>
  row.trashed_at !== null ? 'trashed' : row.archived_at !== null ? 'archived' : 'active';

/** One row's two columns, or `undefined` when the row does not exist. */
function readStateRow(sql: ScopedSql, plan: EntityStatePlan, entityId: string): StateRow | undefined {
  const columns = stateColumnsOf(plan);
  return sql.query<StateRow>(
    `SELECT ${columns.archive ? ARCHIVED_AT_COLUMN : 'NULL'} AS archived_at, ` +
      `${columns.trash ? TRASHED_AT_COLUMN : 'NULL'} AS trashed_at ` +
      `FROM ${plan.table} WHERE ${plan.idColumn} = ?`,
    [entityId],
  )[0];
}

/**
 * The plan for `entityType`, and the key one of its states is gated on — or `validation_failed`
 * naming what the entity does not declare. Shared by the verbs and the trashed readers, so
 * "declares no trash" is one sentence.
 */
export function stateKeyOf(
  plans: ReadonlyMap<string, EntityStatePlan>,
  verb: string,
  entityType: string,
  which: 'archive' | 'trash',
): { plan: EntityStatePlan; key: PermissionKey } {
  const plan = plans.get(entityType);
  const key = which === 'archive' ? plan?.archivePermission : plan?.trashPermission;
  if (!plan || !key) {
    throw substratError('validation_failed', `${verb}: '${entityType}' declares no ${which}`, {
      errors: [{ path: 'entityType', message: `'${entityType}' declares no ${which}` }],
    });
  }
  return { plan, key };
}

/** What the verbs need from the adapter. */
export interface EntityStateDeps {
  /** RAW access inside the operation's own transaction — the guarded `ctx.sql` refuses these columns. */
  sql: ScopedSql;
  /** entity type → its plan, for every registered module. */
  plans: ReadonlyMap<string, EntityStatePlan>;
  /** The operation's instant — what each column is stamped with. */
  now: Instant;
  check: StateCheck;
  /** `ctx.emit`'s kernel writer — stamps the actor, the authorization chain and the operation. */
  emit: (event: DomainEventInput) => void;
  /** K-42's read-only refusal, for the effecting verbs. */
  assertWrites: (verb: string) => void;
}

/** The verbs, as `OperationContext` carries them. */
export type EntityStateVerbs = Pick<OperationContext, 'archive' | 'unarchive' | 'trash' | 'restore' | 'entityState'>;

type Move = {
  readonly verb: string;
  readonly which: 'archive' | 'trash';
  readonly from: readonly EntityStateName[];
  readonly column: 'archived_at' | 'trashed_at';
  readonly set: boolean;
  readonly type: string;
};

const COLUMN = { archived_at: ARCHIVED_AT_COLUMN, trashed_at: TRASHED_AT_COLUMN } as const;

const MOVES = {
  archive: { verb: 'ctx.archive', which: 'archive', from: ['active'], column: 'archived_at', set: true, type: ENTITY_ARCHIVED },
  unarchive: { verb: 'ctx.unarchive', which: 'archive', from: ['archived'], column: 'archived_at', set: false, type: ENTITY_UNARCHIVED },
  // Archived rows may be trashed: "delete this old thing" is the commonest reason to open an
  // archive at all. The archive survives the trip, which is what `restore` relies on.
  trash: { verb: 'ctx.trash', which: 'trash', from: ['active', 'archived'], column: 'trashed_at', set: true, type: ENTITY_TRASHED },
  restore: { verb: 'ctx.restore', which: 'trash', from: ['trashed'], column: 'trashed_at', set: false, type: ENTITY_RESTORED },
} as const satisfies Record<string, Move>;

export function createEntityStateVerbs(deps: EntityStateDeps): EntityStateVerbs {
  const move = async (m: Move, entity: EntityRef): Promise<EntityStateName> => {
    deps.assertWrites(m.verb);
    const { plan, key } = stateKeyOf(deps.plans, m.verb, entity.entityType, m.which);
    // The DECLARED key, on THIS entity, before anything about the row is read: whether it
    // exists is not something a caller without the key gets to learn.
    assertAllowed(await deps.check(key, entity));
    const row = readStateRow(deps.sql, plan, entity.entityId);
    if (!row) {
      throw substratError('not_found', `${m.verb}: ${entity.entityType}:${entity.entityId} does not exist`);
    }
    const from = stateOf(row);
    if (!m.from.includes(from)) {
      throw substratError(
        'conflict',
        `${m.verb}: ${entity.entityType}:${entity.entityId} is ${from} — ` +
          `only ${m.from.join(' or ')} can be moved this way`,
        { reason: 'invalid_transition' },
      );
    }
    const at = m.set ? deps.now : null;
    // The authorization the update trigger asks for, held for exactly this one statement.
    const authorize = [entity.entityType, entity.entityId];
    deps.sql.exec(`INSERT OR IGNORE INTO ${ENTITY_STATE_MOVES_TABLE} (entity_type, entity_id) VALUES (?, ?)`, authorize);
    try {
      const { changes } = deps.sql.exec(`UPDATE ${plan.table} SET ${COLUMN[m.column]} = ? WHERE ${plan.idColumn} = ?`, [
        at,
        entity.entityId,
      ]);
      // The row exists (read above), so an UPDATE that changed nothing was swallowed — a trigger's
      // RAISE(IGNORE), say. Recording a move that did not happen is the one thing this must not do.
      // `0`, not `!== 1`: a Durable Object's count includes the index rows the move rewrote.
      if (changes === 0) {
        throw substratError(
          'internal',
          `${m.verb}: the update of ${entity.entityType}:${entity.entityId} changed no row — nothing was recorded`,
        );
      }
    } finally {
      deps.sql.exec(`DELETE FROM ${ENTITY_STATE_MOVES_TABLE} WHERE entity_type = ? AND entity_id = ?`, authorize);
    }
    const to = stateOf({ ...row, [m.column]: at });
    const payload = entityStateChangedPayload.parse({ entity, from, to }); // strips extra keys
    deps.emit({ type: m.type, schemaVersion: 1, entity: payload.entity, piiClass: 'none', payload });
    return to;
  };

  return {
    archive: (entity) => move(MOVES.archive, entity),
    unarchive: (entity) => move(MOVES.unarchive, entity),
    trash: (entity) => move(MOVES.trash, entity),
    restore: (entity) => move(MOVES.restore, entity),
    entityState: (entity) => {
      const plan = deps.plans.get(entity.entityType);
      if (!plan) {
        throw substratError(
          'validation_failed',
          `ctx.entityState: '${entity.entityType}' declares no archive or trash — declare one on the entity`,
        );
      }
      const row = readStateRow(deps.sql, plan, entity.entityId);
      return row ? stateOf(row) : null;
    },
  };
}
