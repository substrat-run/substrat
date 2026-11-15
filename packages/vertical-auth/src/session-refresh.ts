/**
 * Where a MASTER app keeps the refresh token of each signed-in session (#3161), so it can later
 * obtain a live token of the person and exchange it for a call to one of its plugins as them
 * (`delegatedToken`, `./delegate`).
 *
 * Keyed by the session's random `sid`, which the signed session cookie carries in place of the
 * token: the browser holds the key, the server holds the token, and neither alone is enough.
 * `sub` is kept beside it so a refreshed token can be checked against the person the session
 * was for. A row is deleted at logout; one whose session merely expires is swept by a later
 * {@link RefreshStore.put} (see {@link sqlRefreshStore}). Signing in again never deletes another
 * `sid`'s row: the same person may be signed in on another device.
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

/** The table behind {@link sqlRefreshStore}, and the index its sweep reads. */
export const SESSION_REFRESH_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS session_refresh (sid TEXT PRIMARY KEY, sub TEXT NOT NULL, refresh_token TEXT NOT NULL,
    updated_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS session_refresh_updated_at ON session_refresh (updated_at)`,
];

/**
 * How long a session lives: `SESSION_MAXAGE` in `@substrat-run/oidc-rp`, restated rather than
 * imported because that module's root pulls hono into the identity DO's bundle. A test holds the
 * two equal.
 */
export const SESSION_REFRESH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Rows a single sweep deletes at most. */
export const SESSION_REFRESH_SWEEP_BATCH = 32;

export interface SqlRefreshStoreOptions {
  /** The clock `updated_at` is written and judged by. */
  now?: () => Date;
  /** A row last replaced longer ago than this belongs to an expired session. */
  maxAgeMs?: number;
  /** Rows one sweep deletes at most. */
  sweepBatch?: number;
}

/**
 * A {@link RefreshStore} over the directory's own SQL seam — the identity DO's storage, or a
 * SQLite file on a dev server. The caller runs {@link SESSION_REFRESH_DDL} first. `updated_at` is
 * when the token was last replaced.
 *
 * Every `put` first deletes up to `sweepBatch` rows whose `updated_at` is older than the session
 * lifetime. A session is minted once, at the sign-in that wrote its row, and never extended, so
 * such a row's session has expired and no cookie can name it any more. Each sign-in adds at most
 * one row and sweeps up to a batch, so stale rows cannot pile up while people keep signing in;
 * the cost is one indexed range delete. The refresh token is NOT revoked at the issuer when its
 * row is swept: the RP has no revocation call. It stays valid there until the issuer expires it.
 */
export function sqlRefreshStore(sql: RegistrySql, options: SqlRefreshStoreOptions = {}): RefreshStore {
  const now = options.now ?? (() => new Date());
  const maxAgeMs = options.maxAgeMs ?? SESSION_REFRESH_MAX_AGE_MS;
  const batch = options.sweepBatch ?? SESSION_REFRESH_SWEEP_BATCH;
  return {
    async put(sid, entry) {
      const at = now();
      sql.exec(
        `DELETE FROM session_refresh WHERE sid IN
           (SELECT sid FROM session_refresh WHERE updated_at < ? ORDER BY updated_at LIMIT ?)`,
        new Date(at.getTime() - maxAgeMs).toISOString(),
        batch,
      );
      sql.exec(
        `INSERT INTO session_refresh (sid, sub, refresh_token, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET sub = excluded.sub, refresh_token = excluded.refresh_token, updated_at = excluded.updated_at`,
        sid,
        entry.sub,
        entry.refreshToken,
        at.toISOString(),
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
