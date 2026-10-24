import { instant, verticalOwnerPeriod, type VerticalOwnerPeriod } from '@substrat-run/contracts';
import type { RedactionSql } from './subject-redaction.js';

/**
 * The history of who owned each vertical slug (#2501), as statements both adapters run against
 * their directory: the SQLite host over better-sqlite3, the hosted one inside ControlPlaneDO.
 * Written once so the two cannot keep different histories of the same fleet.
 *
 * `verticals.owner_tenant` says who owns a slug now, and nothing says who owned it before: a slug
 * deleted and registered again, perhaps by another tenant, leaves no trace of the first owner
 * outside the admin log. A later invoice for a past period bills the builder who owned the
 * vertical then, so each registration is a period here: opened in the transaction that inserts
 * the `verticals` row, closed in the one that deletes it. A slug never changes owner in place
 * (a conflicting re-registration is refused), so those two are the only transitions.
 *
 * At most one period of a slug is open, held by a partial unique index. `owner` is NULL for a
 * platform-owned vertical. `(slug, since)` is deliberately not a key: a slug deleted and registered
 * again within one millisecond has two periods with the same `since`, and the second registration
 * must not fail for it.
 */
export const VERTICAL_OWNERS_DDL = `
  CREATE TABLE IF NOT EXISTS _substrat_vertical_owners (
    slug TEXT NOT NULL,
    owner TEXT,
    since TEXT NOT NULL,
    until TEXT
  );
  CREATE INDEX IF NOT EXISTS _substrat_vertical_owners_slug ON _substrat_vertical_owners (slug, since);
  CREATE UNIQUE INDEX IF NOT EXISTS _substrat_vertical_owners_open ON _substrat_vertical_owners (slug) WHERE until IS NULL;
`;

/**
 * Open a period for every registered vertical that has none, from the row's own `created_at`.
 * Run by both adapters' schema pass on every start, which is what backfills a directory from before
 * the history, and by a directory restore after its rows are in, so a dump taken before the history
 * comes back with one. A vertical whose period is open is left alone, so it runs once in effect.
 * A registration before it, of a slug deleted and registered again, is in the admin log only.
 */
export const VERTICAL_OWNERS_BACKFILL = `INSERT INTO _substrat_vertical_owners (slug, owner, since, until)
  SELECT v.slug, v.owner_tenant, v.created_at, NULL FROM verticals v
   WHERE NOT EXISTS (SELECT 1 FROM _substrat_vertical_owners o WHERE o.slug = v.slug AND o.until IS NULL)`;

/**
 * Close every open period whose slug has no `verticals` row, at `at` (or at the period's own
 * `since`, if that is later). A directory restore runs it once the dump's rows are in, so the
 * periods it keeps are consistent with the verticals it restores: an open period with no row
 * would otherwise make the next registration of that slug fail on the open-period index. Closed,
 * not dropped, so the period stays in the history.
 */
export function verticalOwnersStrayCloseSql(at: string): string {
  // Interpolated, not bound: the adapters run it through `exec`. `instant` holds it to an
  // ISO-8601 UTC timestamp, which carries no quote, or throws.
  return `UPDATE _substrat_vertical_owners SET until = MAX(since, '${instant.parse(at)}')
   WHERE until IS NULL AND NOT EXISTS (SELECT 1 FROM verticals v WHERE v.slug = _substrat_vertical_owners.slug)`;
}

/** Open the slug's period as its `verticals` row is inserted, in that insert's transaction. */
export function openVerticalOwnerRow(sql: RedactionSql, slug: string, owner: string | null, since: string): void {
  sql('INSERT INTO _substrat_vertical_owners (slug, owner, since, until) VALUES (?, ?, ?, NULL)', [slug, owner, since]);
}

/** Close the slug's open period as its `verticals` row is deleted, in that delete's transaction. */
export function closeVerticalOwnerRow(sql: RedactionSql, slug: string, until: string): void {
  sql('UPDATE _substrat_vertical_owners SET until = ? WHERE slug = ? AND until IS NULL', [until, slug]);
}

/**
 * Every period of a slug's ownership, oldest first. Parsed on the way out. Two periods with the same
 * `since` are ordered closed first, since only the last can be open; `rowid` breaks whatever tie
 * is left, so the order never depends on the plan.
 */
export function listVerticalOwnerRows(sql: RedactionSql, slug: string): VerticalOwnerPeriod[] {
  const rows = sql(
    'SELECT slug, owner, since, until FROM _substrat_vertical_owners WHERE slug = ? ORDER BY since, until IS NULL, until, rowid',
    [slug],
  ) as {
    slug: string;
    owner: string | null;
    since: string;
    until: string | null;
  }[];
  return rows.map((r) => verticalOwnerPeriod.parse(r));
}
