import { z } from 'zod';
import type { SqlExec } from './introspect.js';
import { REQUIRE_EMAIL_VERIFICATION, isTruthy } from './settings.js';

/**
 * The Username-Password connection's own settings — the password database's answers to
 * questions about itself, kept on the connection the way BankID keeps its own (`src/bankid.ts`):
 * one JSON record in the `config` table. There is exactly one password connection per issuer
 * (`DATABASE_ID = 'password'`), so "per connection" is this one record.
 *
 * It holds `requireEmailVerification` (#3344). That used to be the env-spec key
 * `REQUIRE_EMAIL_VERIFICATION` (#3305), which put a fact about one connection among the
 * install-wide keys. The key is still read, as the FALLBACK, so an install that set it keeps
 * its behaviour with nothing to migrate:
 *
 *   - the connection has a value → that value, whatever the env key says;
 *   - it has none yet            → the env key (deprecated), read with `isTruthy`;
 *   - neither                    → off, which is what every install did before either existed.
 *
 * The first save from the connection's Settings tab writes the connection's own value, and from
 * then on the env key is not read for this connection.
 */

/** The `config` row this connection's record lives under. */
const CONFIG_KEY = 'connection:password';

const stored = z.object({
  requireEmailVerification: z.boolean().optional(),
});
type StoredDatabaseConnection = z.infer<typeof stored>;

/** Where the effective `requireEmailVerification` came from — the console says when it is inherited. */
export type SettingSource = 'connection' | 'env' | 'default';

export interface DatabaseConnectionSettings {
  requireEmailVerification: boolean;
  requireEmailVerificationSource: SettingSource;
}

function readStored(sql: SqlExec): StoredDatabaseConnection {
  const row = sql.exec('SELECT value FROM config WHERE key = ?', CONFIG_KEY).toArray()[0] as
    | { value: string }
    | undefined;
  if (!row) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(row.value);
  } catch {
    return {};
  }
  // An unreadable record reads as "no value", which falls back to the env key — never as on.
  const parsed = stored.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

/**
 * The connection's effective settings. `cfg` is the issuer's merged config (env + delivered
 * `cfg:` rows), consulted only for the deprecated fallback.
 */
export function databaseConnectionSettings(
  sql: SqlExec,
  cfg: Record<string, string | undefined>,
): DatabaseConnectionSettings {
  const own = readStored(sql).requireEmailVerification;
  if (own !== undefined) return { requireEmailVerification: own, requireEmailVerificationSource: 'connection' };
  const env = cfg[REQUIRE_EMAIL_VERIFICATION];
  if (env !== undefined && env.trim() !== '') {
    return { requireEmailVerification: isTruthy(env), requireEmailVerificationSource: 'env' };
  }
  return { requireEmailVerification: false, requireEmailVerificationSource: 'default' };
}

/** Write the named fields; anything not named keeps its stored value. */
export function putDatabaseConnection(
  sql: SqlExec,
  patch: { requireEmailVerification?: boolean },
): void {
  const next: StoredDatabaseConnection = { ...readStored(sql) };
  if (patch.requireEmailVerification !== undefined) next.requireEmailVerification = patch.requireEmailVerification;
  sql.exec('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', CONFIG_KEY, JSON.stringify(next));
}
