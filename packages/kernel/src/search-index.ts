/**
 * Search indexes, derived from `manifest.searchables` (#827).
 *
 * The declaration has been in the manifest since the beginning and nothing read
 * it — `kernel-design.md` §"Search backends" deferred the decision "to first
 * search consumer". This is that consumer, and it takes the FTS half only:
 * `vec0` is rejected by Durable Object SQLite today, so semantic search stays
 * deferred rather than half-built.
 *
 * ## Why the kernel owns the index rather than the module
 *
 * Three reasons, in order of how much they'd hurt to get wrong.
 *
 * 1. **Rule 4 makes it the only legal home for a cross-entity search.** A module
 *    may not reference another module's tables, so a palette searching customers
 *    *and* orders cannot be written by either module. A kernel-owned index over
 *    declared entities can answer it without anyone reading anyone's tables.
 * 2. **Triggers keep the `ctx.sql`-only rule intact.** The index is maintained by
 *    SQL triggers generated from the declaration, so it stays correct no matter
 *    who writes the row — no new write path, no module opting in per `INSERT`,
 *    and nothing to forget. A module that never hears about the index cannot
 *    desynchronise it.
 * 3. **It stays read-after-write correct.** Indexing from the event spine instead
 *    would be eventually consistent, which is why Stripe has to warn "don't use
 *    search for read-after-write flows". Create a customer, then find it in the
 *    picker in the same breath: with triggers that simply works, and a picker
 *    that cannot see what the user just created is the bug report.
 *
 * ## What is derived, and from where
 *
 * Everything. `searchables` names an entity and its fields; `manifestEntities()`
 * enriches that with the entity's `table` and single-column key from the same
 * registry the fields are checked against. So there is no second description of
 * where a customer lives — the model already said it.
 */
import type { SqlMigration } from './scope-host.js';

/** How a declared searchable is matched. `prefix` unless it says otherwise. */
export type SearchTokenizer = 'prefix' | 'substring';

/**
 * One `manifest.searchables` entry, as the kernel needs it.
 *
 * `table` and `idColumn` are not authored — `manifestEntities()` fills them in
 * from the entity registry. A hand-written manifest that declares a searchable
 * without a table is refused rather than guessed at.
 */
export interface SearchableDeclaration {
  readonly entityType: string;
  readonly fields: readonly string[];
  readonly table?: string;
  readonly idColumn?: string;
  readonly tokenizer?: SearchTokenizer;
}

/** A resolved searchable: everything the DDL and the query need, nothing optional. */
export interface SearchIndexPlan {
  readonly moduleId: string;
  readonly entityType: string;
  readonly table: string;
  readonly idColumn: string;
  readonly fields: readonly string[];
  readonly tokenizer: SearchTokenizer;
  /** The FTS5 table. Kernel-owned: `_substrat_*`, which module code may read and never write. */
  readonly indexTable: string;
}

/** One hit. Ids only — the caller hydrates through its own read path. */
export interface SearchHit {
  readonly entityType: string;
  readonly id: string;
  /** FTS5 bm25: lower is better. Carried so a caller can merge two entity types into one list. */
  readonly rank: number;
}

export interface SearchOptions {
  /** Defaults to `DEFAULT_SEARCH_LIMIT`, capped at `MAX_SEARCH_LIMIT`. */
  readonly limit?: number;
}

/**
 * A typeahead wants ten rows, not ten thousand. The cap is the design: a ranked
 * result set has no stable sort key, so it has no honest cursor either — Stripe
 * documents that paginating a ranked search "can reorder some records, causing
 * them to be missing or duplicated on a page". Capping sidesteps that instead of
 * shipping a cursor that lies. Deep paging over search is #811's `Page<T>` over a
 * declared sort, which is a different question with a different answer.
 */
export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 100;

/**
 * The shortest term each tokenizer can answer honestly.
 *
 * Three for `substring` is not a policy choice — it is the trigram index's floor,
 * and it is why Stripe's own substring operator documents "substrings must be a
 * minimum of 3 characters". Two for `prefix` matches the `prefix='2 3'` index
 * below. A shorter term is REFUSED rather than answered by a silent table scan.
 */
export const MIN_SEARCH_TERM: Record<SearchTokenizer, number> = { prefix: 2, substring: 3 };

/** Raised for a term the index cannot answer. Distinguishable from a crash at the seam. */
export class SearchTermTooShort extends Error {
  constructor(readonly minimum: number) {
    super(`search: the term is shorter than ${minimum} characters, which this index cannot match`);
    this.name = 'SearchTermTooShort';
  }
}

/** Raised for an entity type no registered module declares searchable. */
export class NotSearchable extends Error {
  constructor(readonly entityType: string) {
    super(
      `search: '${entityType}' declares no searchable fields — add it to the module's ` +
        '`searchables` (via `manifestEntities`) before searching it',
    );
    this.name = 'NotSearchable';
  }
}

/**
 * SQL identifiers reach the DDL by interpolation — there is no parameter form for
 * a table or column name — so every one of them is checked against this first.
 * The inputs are declarations rather than user input, but a declaration is still
 * a string somebody typed, and "it came from the manifest" is exactly the
 * reasoning that makes an injection a surprise.
 */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdentifier(kind: string, value: string, where: string): string {
  if (!IDENTIFIER.test(value)) {
    throw new Error(`search: ${where} names ${kind} '${value}', which is not a plain SQL identifier`);
  }
  return value;
}

/** `@acme/vertical` → `acme_vertical`: an id is not an identifier, and the index table needs one. */
function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
}

/** The prefix every derived index table carries. Shadow tables inherit it. */
export const SEARCH_INDEX_PREFIX = '_substrat_search_';

/**
 * Is this table part of a derived search index?
 *
 * True for the FTS5 table AND its shadow tables (`…_data`, `…_idx`, `…_config`,
 * `…_docsize`), which SQLite names by prefixing the virtual table's own name.
 *
 * **Used to keep the index OUT of a scope dump.** A dump replays DDL and then
 * inserts rows, and a shadow table refuses both — workerd answers "object name
 * reserved for internal use", and D1's exporter refuses a whole database that
 * merely contains an fts5 table (cloudflare/workers-sdk#9519). Excluding it is
 * also just correct: an index is derived data, and the import rebuilds it from
 * the content tables it just loaded. Nothing is lost that was not recomputable.
 */
export function isSearchIndexTable(name: string): boolean {
  return name.startsWith(SEARCH_INDEX_PREFIX);
}

/**
 * Resolve one module's declarations into plans.
 *
 * Refuses rather than skips. A `searchables` entry that cannot become an index is
 * a declaration the author believes is live, and the failure mode of skipping is
 * a search box that returns nothing with no error anywhere — the exact silence
 * this feature exists to end.
 */
export function searchIndexPlans(
  moduleId: string,
  searchables: readonly SearchableDeclaration[] | undefined,
): SearchIndexPlan[] {
  if (!searchables?.length) return [];
  const plans: SearchIndexPlan[] = [];
  for (const decl of searchables) {
    const where = `${moduleId} searchables['${decl.entityType}']`;
    if (!decl.table) {
      throw new Error(
        `search: ${where} carries no table — declare searchables through \`manifestEntities()\` ` +
          'so the entity registry supplies it, rather than by hand',
      );
    }
    if (!decl.fields.length) {
      throw new Error(`search: ${where} declares no fields`);
    }
    const table = assertIdentifier('a table', decl.table, where);
    const idColumn = assertIdentifier('an id column', decl.idColumn ?? 'id', where);
    const fields = decl.fields.map((f) => assertIdentifier('a field', f, where));
    if (new Set(fields).size !== fields.length) {
      throw new Error(`search: ${where} repeats a field — (${fields.join(', ')})`);
    }
    plans.push({
      moduleId,
      entityType: decl.entityType,
      table,
      idColumn,
      fields,
      tokenizer: decl.tokenizer ?? 'prefix',
      indexTable: `_substrat_search_${slug(moduleId)}_${slug(decl.entityType)}`,
    });
  }
  return plans;
}

/**
 * The FTS5 tokenizer clause for a plan.
 *
 * `prefix` — `unicode61` with a prefix index, which is what a typeahead over
 * names actually wants: real tokens, clean bm25 ranking, a small index.
 * `substring` — `trigram`, which matches inside a word ("ande" in "Andersson")
 * at the cost of a substantially larger index. Opt-in per entity, because it is
 * a real cost and only some fields want it.
 */
function tokenizeClause(tokenizer: SearchTokenizer): string {
  return tokenizer === 'substring'
    ? "tokenize='trigram'"
    : "tokenize='unicode61', prefix='2 3'";
}

/**
 * The DDL for one plan: an external-content FTS5 table, the three triggers that
 * keep it in step, and a rebuild.
 *
 * **External content, not a copy.** The index stores terms and points at the
 * source table's `rowid`; the text itself is not duplicated. That also makes
 * `rebuild` the whole backfill story — it reads the content table.
 *
 * **Drop-then-create, every time the declaration changes.** The version below is
 * the declaration itself, so adding a field re-runs this, and re-running has to
 * produce an index matching the NEW declaration rather than silently keeping the
 * old columns. Nothing is lost by dropping: an index is derived data, and the
 * rebuild at the end reconstructs it from rows that never moved.
 */
export function searchIndexDdl(plan: SearchIndexPlan): string {
  const idx = plan.indexTable;
  const cols = plan.fields.join(', ');
  const newCols = plan.fields.map((f) => `new.${f}`).join(', ');
  const oldCols = plan.fields.map((f) => `old.${f}`).join(', ');
  return [
    `DROP TRIGGER IF EXISTS ${idx}_ai;`,
    `DROP TRIGGER IF EXISTS ${idx}_ad;`,
    `DROP TRIGGER IF EXISTS ${idx}_au;`,
    `DROP TABLE IF EXISTS ${idx};`,
    `CREATE VIRTUAL TABLE ${idx} USING fts5(`,
    `  ${cols},`,
    `  content='${plan.table}', content_rowid='rowid', ${tokenizeClause(plan.tokenizer)}`,
    `);`,
    `CREATE TRIGGER ${idx}_ai AFTER INSERT ON ${plan.table} BEGIN`,
    `  INSERT INTO ${idx}(rowid, ${cols}) VALUES (new.rowid, ${newCols});`,
    `END;`,
    `CREATE TRIGGER ${idx}_ad AFTER DELETE ON ${plan.table} BEGIN`,
    `  INSERT INTO ${idx}(${idx}, rowid, ${cols}) VALUES('delete', old.rowid, ${oldCols});`,
    `END;`,
    `CREATE TRIGGER ${idx}_au AFTER UPDATE ON ${plan.table} BEGIN`,
    `  INSERT INTO ${idx}(${idx}, rowid, ${cols}) VALUES('delete', old.rowid, ${oldCols});`,
    `  INSERT INTO ${idx}(rowid, ${cols}) VALUES (new.rowid, ${newCols});`,
    `END;`,
    `INSERT INTO ${idx}(${idx}) VALUES('rebuild');`,
  ].join('\n');
}

/**
 * The migrations that provision a module's declared indexes, journaled like any
 * other so a scope applies them once and a changed declaration re-applies.
 *
 * **The version IS the declaration.** `search/customer:prefix:name+number` says
 * everything that decides the DDL, so adding a field or switching a tokenizer
 * produces a new version and re-runs; changing nothing produces the same version
 * and does not. A hash would say the same thing less legibly in the one place an
 * operator reads when a scope is stuck (`_substrat_migrations`).
 *
 * Appended AFTER the module's own migrations by the adapter, which is what makes
 * the content table exist by the time the trigger references it.
 */
export function searchIndexMigrations(
  moduleId: string,
  searchables: readonly SearchableDeclaration[] | undefined,
): SqlMigration[] {
  return searchIndexPlans(moduleId, searchables).map((plan) => ({
    version: `search/${plan.entityType}:${plan.tokenizer}:${plan.fields.join('+')}`,
    sql: searchIndexDdl(plan),
  }));
}

/**
 * Index the plans by entity type for a whole scope, refusing an ambiguity.
 *
 * Two modules declaring the same entity type searchable is not resolvable by
 * picking one: `ctx.search('customer', …)` would mean different rows depending
 * on registration order, which is the kind of fact that stays true in tests and
 * changes in production.
 */
export function searchPlansByEntityType(
  modules: readonly { readonly id: string; readonly searchables?: readonly SearchableDeclaration[] }[],
): Map<string, SearchIndexPlan> {
  const byType = new Map<string, SearchIndexPlan>();
  for (const mod of modules) {
    for (const plan of searchIndexPlans(mod.id, mod.searchables)) {
      const existing = byType.get(plan.entityType);
      if (existing) {
        throw new Error(
          `search: '${plan.entityType}' is declared searchable by both '${existing.moduleId}' and ` +
            `'${plan.moduleId}' — one entity type, one index; rename one`,
        );
      }
      byType.set(plan.entityType, plan);
    }
  }
  return byType;
}

/**
 * Turn what a person typed into an FTS5 MATCH expression.
 *
 * **Everything is quoted, always.** FTS5's query syntax has operators (`AND`,
 * `OR`, `NOT`, `*`, `^`, `:`, `"`) and a picker's input is a name, not a query —
 * someone searching for `AND Sons` or `O"Brien` must get rows, not a syntax
 * error, and must not be able to steer the match. So the input is split into
 * bare terms and each is re-emitted as a quoted string.
 *
 * **In prefix mode every term is a prefix, not just the last.** The obvious rule
 * — only the final token is still being typed — was measured against a real index
 * and is wrong: `unicode61` tokenizes "Andersson Fastigheter AB" into whole
 * words, so someone typing "anders fast" matched NOTHING while "anders" alone
 * matched. In a picker every token is plausibly half-typed. Prefixing all of them
 * can only widen the result set, and the set is ranked and capped anyway.
 *
 * **In substring mode nothing is appended, and short terms are dropped.** Trigram
 * matching is already inside-the-word, and appending `*` there is a documented
 * trap that changes the results rather than widening them. A term below the
 * trigram floor is silently ignored BY THE INDEX (measured: `"AND" "x" "OR"`
 * matched "Andersson" — the `x` constrained nothing), so it is dropped here
 * instead, where the behaviour is written down rather than inferred from a match
 * that looks wrong.
 */
export function searchMatchExpression(term: string, tokenizer: SearchTokenizer): string {
  const minimum = MIN_SEARCH_TERM[tokenizer];
  const all = term.split(/[^\p{L}\p{N}_]+/u).filter((t) => t.length > 0);
  // Substring: a below-floor term is dropped, not carried. Prefix: kept, because
  // a one-character term still matches a one-character token exactly.
  const terms = tokenizer === 'substring' ? all.filter((t) => t.length >= minimum) : all;
  // At least one term has to reach the floor. Otherwise the query is `"a"` — a
  // whole-scope scan dressed as a search — and the caller learns nothing from an
  // empty result. Refusing says which.
  if (!terms.some((t) => t.length >= minimum)) throw new SearchTermTooShort(minimum);
  const quoted = terms.map((t) => {
    const literal = `"${t.replace(/"/g, '""')}"`;
    // Below the prefix index's floor ('2 3') a `*` would scan every term in the
    // scope, so a one-character token is matched whole instead.
    return tokenizer === 'prefix' && t.length >= 2 ? `${literal}*` : literal;
  });
  return quoted.join(' ');
}

/**
 * The read: ids and ranks, joined back to the content table for the declared id.
 *
 * Ids ONLY, deliberately. The row shape a caller wants is its own — its
 * projections, its joins, its permission narrowing — and returning rows here
 * would be a second read path with a second answer to "what is a customer".
 * Hydrating through the module's own query keeps that one code path, at the cost
 * of one extra `WHERE id IN (…)` the caller was going to write anyway.
 *
 * **The FTS table is not aliased, and cannot be.** `MATCH` and `bm25()` both take
 * the table's own name — that name IS the hidden column being matched — so
 * aliasing it to `idx` and writing `WHERE idx MATCH ?` fails at prepare time with
 * "no such column: idx". Found by running the emitted SQL rather than reading it.
 */
export function searchQuery(
  plan: SearchIndexPlan,
  match: string,
  limit: number,
): { sql: string; params: [string, number] } {
  const idx = plan.indexTable;
  return {
    sql:
      `SELECT src.${plan.idColumn} AS id, bm25(${idx}) AS rank ` +
      `FROM ${idx} JOIN ${plan.table} src ON src.rowid = ${idx}.rowid ` +
      `WHERE ${idx} MATCH ? ORDER BY rank LIMIT ?`,
    params: [match, limit],
  };
}

/** Clamp a caller's `limit` into the range the index will answer. */
export function searchLimit(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_SEARCH_LIMIT;
  if (!Number.isFinite(requested) || requested < 1) return DEFAULT_SEARCH_LIMIT;
  return Math.min(Math.floor(requested), MAX_SEARCH_LIMIT);
}
