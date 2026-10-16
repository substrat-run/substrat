import { declarationBytes, utf8Length } from './deploy.js';

/** A migration as the diff reads it: a `DeclaredMigration`, or anything shaped like one. */
type MigrationLike = {
  moduleId: string;
  version: string;
  sql: string;
  moves?: Readonly<Record<string, string>>;
  discards?: Readonly<Record<string, string>>;
};

/**
 * The migrations a version adds on top of another (#1677): what the promote dialog and
 * `substrat promote` show a person before they acknowledge a migration change.
 *
 * Read from the `migrations` each version's manifest carries, as the control plane STORED
 * them — never from the digest the pushing client computed, which nothing re-derives. So a
 * declaration the version carries is always in this answer (or flagged as left out), whatever
 * `digests.migration` says. Pure, so the route stays a read and the bounds are testable
 * without one.
 */

/** At most this many migrations in one answer. The rest are counted in `total`. */
export const MIGRATION_READ_MAX = 200;
/**
 * At most this many bytes of SQL and declarations in one answer. A migration past the budget
 * keeps its id, with `sql: null` (and `declarationsLeftOut` when it declares anything).
 */
export const MIGRATION_READ_SQL_BYTES_MAX = 256 * 1024;

export interface MigrationEntry {
  moduleId: string;
  version: string;
  /** Null when the answer's SQL budget ran out before this entry. The id is still listed. */
  sql: string | null;
  /**
   * Data the migration declares it MOVES (#2322): `{ source: target }`, verified by the kernel
   * at apply (#115). Absent when it declares none, or when `declarationsLeftOut` is set.
   */
  moves?: Record<string, string>;
  /**
   * Data the migration declares it deliberately LOSES: `{ target: reason }`. The reason is the
   * migration author's own text, shown verbatim. Absent when it declares none, or when
   * `declarationsLeftOut` is set.
   */
  discards?: Record<string, string>;
  /**
   * Set when the migration declares moves or discards and the answer's budget ran out before
   * them: a reader must say "declares data losses that are not shown", never "declares none".
   */
  declarationsLeftOut?: true;
  /**
   * Only on a `changed` entry: what differs from the base version's migration under the same
   * id. `declarations` is the same SQL with other moves or discards — a scope that already ran
   * it is unaffected, one that has not is held to the new declarations. Absent reads as `sql`
   * (an answer from before #2322).
   */
  edited?: 'sql' | 'declarations';
}

export interface MigrationDiff {
  /**
   * What `added` is relative to:
   * - `version`: the base version's own migrations.
   * - `none`: no base was named (a first promote), so every migration is listed.
   * - `unavailable`: the base was pushed before manifests carried migrations, so every
   *   migration is listed and nothing can say which of them are new.
   */
  baseline: 'version' | 'none' | 'unavailable';
  /** Migrations the base does not have, in the order the host runs them. */
  added: MigrationEntry[];
  /**
   * Migrations the base also has, under the same `(moduleId, version)`, with different SQL or
   * different declarations (`edited` says which). A shipped migration was edited. A scope that
   * already journaled it will NOT run the new SQL, which is why it is listed apart from `added`.
   */
  changed: MigrationEntry[];
  /** `added` plus `changed`, before the count bound. */
  total: number;
  /** True when entries were left out, or when an entry's SQL or declarations were. */
  truncated: boolean;
}

const keyOf = (m: { moduleId: string; version: string }): string => `${m.moduleId}\u001f${m.version}`;

/** A declaration record in one canonical spelling, so key order never reads as an edit. */
const canonical = (r: Readonly<Record<string, string>> | undefined): string =>
  JSON.stringify(Object.entries(r ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

const sameDeclarations = (a: MigrationLike, b: MigrationLike): boolean =>
  canonical(a.moves) === canonical(b.moves) && canonical(a.discards) === canonical(b.discards);

const declares = (m: MigrationLike): boolean =>
  Object.keys(m.moves ?? {}).length > 0 || Object.keys(m.discards ?? {}).length > 0;

/**
 * `incoming` is the promoted version's migrations. `base` is the serving version's:
 * `undefined` when there is none to compare with, `null` when it carries none.
 */
export function migrationsOnTop(
  incoming: readonly MigrationLike[],
  base: readonly MigrationLike[] | null | undefined,
): MigrationDiff {
  const before = new Map((base ?? []).map((m) => [keyOf(m), m]));
  const added: MigrationLike[] = [];
  const changed: { m: MigrationLike; edited: 'sql' | 'declarations' }[] = [];
  for (const m of incoming) {
    const was = before.get(keyOf(m));
    if (was === undefined) added.push(m);
    else if (was.sql !== m.sql) changed.push({ m, edited: 'sql' });
    else if (!sameDeclarations(was, m)) changed.push({ m, edited: 'declarations' });
  }

  // One pass, `changed` first: an edited shipped migration is the case a person most needs
  // to see, so it is the first to be kept and the first to spend the budget. Within an entry
  // the declarations are charged before the SQL: what a migration may lose is the one thing a
  // person approving it against live data most needs, and they are small beside the SQL.
  let budget = MIGRATION_READ_SQL_BYTES_MAX;
  const entry = (m: MigrationLike, edited?: 'sql' | 'declarations'): MigrationEntry => {
    const out: MigrationEntry = { moduleId: m.moduleId, version: m.version, sql: null };
    if (declares(m)) {
      const size = declarationBytes(m);
      if (size > budget) {
        out.declarationsLeftOut = true;
      } else {
        budget -= size;
        if (Object.keys(m.moves ?? {}).length > 0) out.moves = { ...m.moves };
        if (Object.keys(m.discards ?? {}).length > 0) out.discards = { ...m.discards };
      }
    }
    const size = utf8Length(m.sql);
    if (size <= budget) {
      budget -= size;
      out.sql = m.sql;
    }
    if (edited) out.edited = edited;
    return out;
  };
  const kept = [...changed, ...added.map((m) => ({ m, edited: undefined }))]
    .slice(0, MIGRATION_READ_MAX)
    .map((c) => entry(c.m, c.edited));
  const total = added.length + changed.length;

  return {
    baseline: base === undefined ? 'none' : base === null ? 'unavailable' : 'version',
    added: kept.slice(changed.length),
    changed: kept.slice(0, changed.length),
    total,
    truncated: kept.length < total || kept.some((e) => e.sql === null || e.declarationsLeftOut === true),
  };
}

/**
 * The Unicode bidirectional controls: embeddings and overrides (U+202A–U+202E), isolates
 * (U+2066–U+2069), and the marks (U+200E, U+200F, U+061C). Invisible, and able to make text
 * read in an order other than the one it is stored in.
 */
const BIDI_CONTROLS = /[‪-‮⁦-⁩‎‏؜]/g;

/**
 * Pusher-supplied text (a discard's reason, a declared target) as a review shows it (#2322):
 * every bidirectional control replaced by a visible `<U+XXXX>`, so a reason cannot reorder
 * what a reviewer reads — say, make "keeps" display where "drops" is stored. The rest is kept
 * verbatim; each surface still escapes for its own medium (React's text node, the CLI's
 * `JSON.stringify`).
 */
export function reviewText(text: string): string {
  return text.replace(BIDI_CONTROLS, (c) => `<U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}>`);
}

/** How many places a diff's shown entries declare they deliberately discard data. */
export function discardCount(diff: Pick<MigrationDiff, 'added' | 'changed'>): number {
  return [...diff.changed, ...diff.added].reduce((n, e) => n + Object.keys(e.discards ?? {}).length, 0);
}
