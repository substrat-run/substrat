import type { SqlExec } from './introspect.js';

/**
 * WHEN a person last signed in, and when each application last got a token for them (#3107).
 *
 * The questions an operator's own admin app asks — "who is actually using what" — and the
 * Management API's answers to them (`management-api.ts`): `last_login` and `logins_count` on
 * the Auth0 user object, and the per-application times on an extension endpoint, since Auth0
 * keeps no such record.
 *
 * The sign-in log (`sign-in-log.ts`) already sees every one of these moments, but it forgets
 * after thirty days by design. These two tables keep only the times and a count, and keep them
 * for as long as the person exists: both cascade with the user, and the per-application row
 * with the client too.
 *
 * Neither writer may cost anyone a sign-in or a token, so both swallow their own errors, the
 * way `recordSignInAttempt` does.
 */

/** SQLite's own clock, in the epoch-ms every timestamp here is stored as. */
const NOW_MS = `cast(unixepoch('subsecond') * 1000 as integer)`;

/** One successful sign-in at this issuer. What Auth0 counts in `logins_count`. */
export function recordLogin(sql: SqlExec, userId: string): void {
  try {
    sql.exec(
      `INSERT INTO user_activity (user_id, last_login_at, logins_count) VALUES (?, ${NOW_MS}, 1)
       ON CONFLICT (user_id) DO UPDATE SET last_login_at = excluded.last_login_at, logins_count = logins_count + 1`,
      userId,
    );
  } catch {
    // A person deleted mid-sign-in fails the foreign key. Nothing to record for them.
  }
}

/** A token minted to `clientId` for `userId`, by any grant a person stands behind. */
export function recordClientToken(sql: SqlExec, userId: string, clientId: string): void {
  try {
    sql.exec(
      `INSERT INTO user_client_activity (user_id, client_id, last_token_at) VALUES (?, ?, ${NOW_MS})
       ON CONFLICT (user_id, client_id) DO UPDATE SET last_token_at = excluded.last_token_at`,
      userId,
      clientId,
    );
  } catch {
    // The same foreign-key race, from either side.
  }
}

/**
 * Carry `retired`'s activity onto `survivor` before an account merge deletes `retired`
 * (`account-merge.ts`). The latest time wins and the counts add, so the survivor reads as
 * though every sign-in of both had been its own, which is what the merge says happened.
 */
export function foldActivity(sql: SqlExec, survivorId: string, retiredId: string): void {
  sql.exec(
    `INSERT INTO user_activity (user_id, last_login_at, logins_count)
       SELECT ?, last_login_at, logins_count FROM user_activity WHERE user_id = ?
     ON CONFLICT (user_id) DO UPDATE SET
       last_login_at = max(coalesce(last_login_at, 0), coalesce(excluded.last_login_at, 0)),
       logins_count = logins_count + excluded.logins_count`,
    survivorId,
    retiredId,
  );
  sql.exec(
    `INSERT INTO user_client_activity (user_id, client_id, last_token_at)
       SELECT ?, client_id, last_token_at FROM user_client_activity WHERE user_id = ?
     ON CONFLICT (user_id, client_id) DO UPDATE SET last_token_at = max(last_token_at, excluded.last_token_at)`,
    survivorId,
    retiredId,
  );
}

/** The config row that says the one-time fill below has run. */
const BACKFILLED_KEY = 'user_activity_backfilled';

/**
 * Fill both tables ONCE, from what this issuer already holds, so an existing install does not
 * answer "never signed in" for everybody on the day it upgrades.
 *
 * `last_login_at` is the latest of a successful sign-in in the log and a session's creation.
 * `logins_count` is the successful sign-ins the log still holds — an undercount for anyone who
 * signed in before the log's thirty days, which the compatibility table says. A per-application
 * time is the latest token or consent row for the pair; a JWT access token is never stored, so
 * an application that only ever got those starts at its next sign-in.
 *
 * Runs at boot in both runtimes, after the DDL. Returns whether it ran.
 */
export function backfillActivity(sql: SqlExec): boolean {
  if (sql.exec('SELECT 1 FROM config WHERE key = ?', BACKFILLED_KEY).toArray().length) return false;
  sql.exec(
    `INSERT OR IGNORE INTO user_activity (user_id, last_login_at, logins_count)
     SELECT u.id,
            max(coalesce((SELECT max(at) FROM sign_in_attempt a WHERE a.user_id = u.id AND a.outcome = 'succeeded'), 0),
                coalesce((SELECT max(created_at) FROM session s WHERE s.user_id = u.id), 0)),
            (SELECT count(*) FROM sign_in_attempt a WHERE a.user_id = u.id AND a.outcome = 'succeeded')
     FROM user u
     WHERE EXISTS (SELECT 1 FROM sign_in_attempt a WHERE a.user_id = u.id AND a.outcome = 'succeeded')
        OR EXISTS (SELECT 1 FROM session s WHERE s.user_id = u.id)`,
  );
  sql.exec(
    `INSERT OR IGNORE INTO user_client_activity (user_id, client_id, last_token_at)
     SELECT t.user_id, t.client_id, max(t.at) FROM (
       SELECT user_id, client_id, created_at AS at FROM oauth_access_token WHERE user_id IS NOT NULL
       UNION ALL SELECT user_id, client_id, created_at FROM oauth_refresh_token
       UNION ALL SELECT user_id, client_id, updated_at FROM oauth_consent WHERE user_id IS NOT NULL
     ) t
     JOIN user u ON u.id = t.user_id
     JOIN oauth_client c ON c.client_id = t.client_id
     GROUP BY t.user_id, t.client_id`,
  );
  sql.exec(`INSERT INTO config (key, value) VALUES (?, ${NOW_MS})`, BACKFILLED_KEY);
  return true;
}

/** One person's activity, as the Management API reads it. */
export interface UserActivity {
  lastLoginAt: number | null;
  loginsCount: number;
}

export function readActivity(sql: SqlExec, userId: string): UserActivity {
  const row = sql
    .exec('SELECT last_login_at, logins_count FROM user_activity WHERE user_id = ?', userId)
    .toArray()[0] as { last_login_at: number | null; logins_count: number } | undefined;
  return { lastLoginAt: row?.last_login_at || null, loginsCount: row?.logins_count ?? 0 };
}

/** Each application that has had a token for this person, newest first, with its name. */
export interface ClientActivity {
  clientId: string;
  name: string | null;
  lastTokenAt: number;
}

export function readClientActivity(sql: SqlExec, userId: string): ClientActivity[] {
  const rows = sql
    .exec(
      `SELECT a.client_id, c.name, a.last_token_at FROM user_client_activity a
       JOIN oauth_client c ON c.client_id = a.client_id
       WHERE a.user_id = ? ORDER BY a.last_token_at DESC`,
      userId,
    )
    .toArray() as { client_id: string; name: string | null; last_token_at: number }[];
  return rows.map((r) => ({ clientId: r.client_id, name: r.name, lastTokenAt: r.last_token_at }));
}
