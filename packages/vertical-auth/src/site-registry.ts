/**
 * The per-tenant SITE REGISTRY (M2 of multi-scope-manyfold.md) — the vertical's own memory of
 * its sites (each site IS a scope), so it can list and switch between them CP-lessly. Kept as
 * plain functions over a minimal SQLite `exec` seam rather than methods on the IdentityDO, so
 * the logic is unit-testable against a plain SQLite without standing up a Durable Object (the
 * DO module pulls in Better Auth, which the workers test pool cannot load). The IdentityDO's
 * `recordSite`/`listSites`/`resolveSiteScope` delegate here.
 */

/**
 * The slice of `SqlStorage` the registry uses: `exec(query, ...params)` returning an iterable
 * of row objects. Both the DO's `ctx.storage.sql` and a plain SQLite driver satisfy it.
 */
export interface RegistrySql {
  exec(query: string, ...params: unknown[]): Iterable<Record<string, unknown>>;
}

/** The `site` table (+ slug index), folded into the IdentityDO's schema statements. */
export const SITE_REGISTRY_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS site (scope_id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)))`,
  `CREATE INDEX IF NOT EXISTS site_by_slug ON site (slug)`,
];

export interface SiteRow {
  scopeId: string;
  slug: string;
  name: string;
}

/**
 * Record a site at provision. Idempotent: a re-provision (K-31) updates the slug/name in place
 * but keeps `created_at`, so the switcher's ordering stays stable.
 */
export function recordSite(sql: RegistrySql, scopeId: string, slug: string, name: string): void {
  sql.exec(
    `INSERT INTO site (scope_id, slug, name) VALUES (?, ?, ?)
     ON CONFLICT(scope_id) DO UPDATE SET slug = excluded.slug, name = excluded.name`,
    scopeId,
    slug,
    name,
  );
}

/** The tenant's sites, oldest first — the in-app site switcher's list. */
export function listSites(sql: RegistrySql): SiteRow[] {
  return [...sql.exec('SELECT scope_id, slug, name FROM site ORDER BY created_at')].map((r) => ({
    scopeId: r.scope_id as string,
    slug: r.slug as string,
    name: r.name as string,
  }));
}

/**
 * Resolve a site SLUG to its scope id — how the worker turns the app's `x-site` selection into
 * the scope to open. Null ⇒ no such site. Tenant-scoped by construction: the registry lives in
 * a per-tenant DO, so a slug can only resolve to a scope of that tenant.
 */
export function resolveSiteScope(sql: RegistrySql, slug: string): string | null {
  const row = [...sql.exec('SELECT scope_id FROM site WHERE slug = ?', slug)][0] as
    | { scope_id: string }
    | undefined;
  return row ? row.scope_id : null;
}
