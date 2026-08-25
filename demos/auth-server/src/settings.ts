import type { EnvVarSpec } from '@substrat-run/contracts';
import type { SqlExec } from './introspect.js';

/**
 * Issuer settings that an administrator can change WITHOUT a redeploy — today just one:
 * whether people may create their own account.
 *
 * There is no second settings store. A setting here is an ordinary declared env-spec key
 * (`src/manifest.ts`), and the dashboard writes it to exactly the row the platform's own
 * `/internal/configure` writes — `config` under `cfg:<KEY>`. `effectiveCfg()` in the DO
 * already merges those rows over worker env with instance config winning, so one key is
 * settable three ways (wrangler var, platform Env tab, this dashboard) and read one way.
 *
 * Both runtimes rebuild Better Auth per request from that merge, so a toggle takes effect on
 * the next request rather than the next deploy.
 */

/** The declared key behind the sign-up toggle. */
export const ALLOW_SIGNUP = 'ALLOW_SIGNUP';

/**
 * Read a declared boolean config value. Absent ⇒ false: an issuer that lets strangers
 * create accounts is a decision someone has to make, so it is never the default.
 */
export function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

/** The canonical string form written back for a toggle. */
export function boolValue(on: boolean): string {
  return on ? 'true' : 'false';
}

/** The per-instance `cfg:` rows for the DECLARED keys — a stray delivered key is never read. */
export function deliveredConfig(sql: SqlExec, specs: EnvVarSpec[]): Record<string, string> {
  const delivered: Record<string, string> = {};
  for (const spec of specs) {
    const row = sql.exec('SELECT value FROM config WHERE key = ?', `cfg:${spec.key}`).toArray()[0] as
      | { value: string }
      | undefined;
    if (row) delivered[spec.key] = row.value;
  }
  return delivered;
}

/** Upsert per-instance config rows — key by key, so partial deliveries compose. */
export function putDeliveredConfig(sql: SqlExec, entries: { key: string; value: string }[]): void {
  for (const { key, value } of entries) {
    sql.exec('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', `cfg:${key}`, value);
  }
}
