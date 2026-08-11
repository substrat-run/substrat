import type { ScopeDumpTable } from '@substrat-run/contracts';
import type { SqlExec } from './introspect.js';

/**
 * A COMPLETE, byte-faithful dump of one issuer's SQLite (#590) — the read half of the
 * platform's data verbs (`/internal/export`), what makes an auth-server install
 * backed-up-reapable (#493), exportable, and movable between lineages
 * (`rebindScopeVertical`).
 *
 * Deliberately the OPPOSITE of `introspect.ts`: no redaction. A dump exists to rebuild
 * this issuer elsewhere, so the signing secret, password hashes, session tokens and JWKS
 * private keys MUST ride along — a dump with `[redacted]` cells restores into an issuer
 * whose every credential is broken. The control-plane route in front is the gate, the
 * auditor, and the default masker (staff-only, jurisdiction-checked), exactly as for
 * every other vertical's export.
 *
 * Mirrors the platform ScopeDO's `exportDump` (adapter-cloudflare scope-do.ts): every
 * real table with its DDL and positional rows, dropping only SQLite's own `sqlite_*`
 * internals (auto-managed, and `CREATE TABLE sqlite_*` is rejected on reload). Safe as
 * a consistent snapshot because the DO is single-threaded — no concurrent writer.
 */
export function exportDump(sql: SqlExec): ScopeDumpTable[] {
  const defs = sql
    .exec(
      `SELECT name, sql FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
        ORDER BY name`,
    )
    .toArray() as { name: string; sql: string }[];
  return defs.map(({ name, sql: ddl }) => {
    const cursor = sql.exec(`SELECT * FROM "${name}"`);
    const columns = cursor.columnNames;
    const rows = Array.from(cursor.raw(), (row) => row as unknown[]);
    return { name, ddl, columns, rows };
  });
}
