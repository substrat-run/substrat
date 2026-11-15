/**
 * Where a MASTER app keeps the refresh token of each signed-in session (#3161), so it can later
 * obtain a live token of the person and exchange it for a call to one of its plugins as them
 * (`delegatedToken`, `./delegate`).
 *
 * Keyed by the session's random `sid`, which the signed session cookie carries in place of the
 * token: the browser holds the key, the server holds the token, and neither alone is enough.
 * `sub` is kept beside it so a refreshed token can be checked against the person the session
 * was for. A row is deleted at logout; one whose session merely expires stays until something
 * sweeps it (nothing does yet), unreachable without the cookie that named it.
 */
import type { RegistrySql } from './site-registry.js';
import type { IdentityStub } from './identity-do.js';

export interface RefreshEntry {
  sub: string;
  refreshToken: string;
}

export interface RefreshStore {
  put(sid: string, entry: RefreshEntry): Promise<void>;
  get(sid: string): Promise<RefreshEntry | null>;
  delete(sid: string): Promise<void>;
}

/** The table behind {@link sqlRefreshStore}. */
export const SESSION_REFRESH_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS session_refresh (sid TEXT PRIMARY KEY, sub TEXT NOT NULL, refresh_token TEXT NOT NULL,
    updated_at TEXT NOT NULL)`,
];

/**
 * A {@link RefreshStore} over the directory's own SQL seam — the identity DO's storage, or a
 * SQLite file on a dev server. The caller runs {@link SESSION_REFRESH_DDL} first. `updated_at` is
 * when the token was last replaced, for a sweep to read.
 */
export function sqlRefreshStore(sql: RegistrySql): RefreshStore {
  return {
    async put(sid, entry) {
      sql.exec(
        `INSERT INTO session_refresh (sid, sub, refresh_token, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET sub = excluded.sub, refresh_token = excluded.refresh_token, updated_at = excluded.updated_at`,
        sid,
        entry.sub,
        entry.refreshToken,
        new Date().toISOString(),
      );
    },
    async get(sid) {
      const row = [...sql.exec('SELECT sub, refresh_token FROM session_refresh WHERE sid = ?', sid)][0];
      return row ? { sub: row.sub as string, refreshToken: row.refresh_token as string } : null;
    },
    async delete(sid) {
      sql.exec('DELETE FROM session_refresh WHERE sid = ?', sid);
    },
  };
}

/** A {@link RefreshStore} over the tenant's identity DO, for a hosted worker. */
export function identityRefreshStore(
  directory: Pick<IdentityStub, 'putSessionRefresh' | 'sessionRefresh' | 'deleteSessionRefresh'>,
): RefreshStore {
  return {
    put: (sid, entry) => directory.putSessionRefresh(sid, entry),
    get: (sid) => directory.sessionRefresh(sid),
    delete: (sid) => directory.deleteSessionRefresh(sid),
  };
}
