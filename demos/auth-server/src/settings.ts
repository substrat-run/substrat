import type { EnvVarSpec } from '@substrat-run/contracts';
import type { SqlExec } from './introspect.js';

/**
 * Issuer settings that an administrator can change WITHOUT a redeploy: whether people may
 * create their own account, and what happens when a federated sign-in's address already
 * belongs to one.
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

/** The declared key behind the account-linking mode. */
export const ACCOUNT_LINKING = 'ACCOUNT_LINKING';

/**
 * What this issuer does when someone arrives through an upstream whose email address already
 * belongs to a local account.
 *
 * TWO values, not three, and the missing one is worth naming because every other IdP offers
 * it: "keep them as separate accounts" is not implementable here. Better Auth declares
 * `user.email` UNIQUE in its own table definitions, and — the half that survives dropping the
 * index — resolves email to a user with a bare `findOne` in the password sign-in, password
 * reset, sign-up, admin create-user, email-verification, magic-link and OTP paths. Two rows at
 * one address make each of those pick arbitrarily, which for sign-in and reset means the wrong
 * person's account. So the choice is genuinely between joining and refusing.
 *
 *   - `link`  — join them, on Better Auth's own terms: the upstream must vouch for the address
 *               (or be trusted here), AND the local account must have a verified address.
 *   - `block` — never join implicitly. The person proves the existing account by signing in
 *               the way they already can, then connects the provider deliberately from inside
 *               that session — which is the path the refusal message already names.
 *
 * `block` does NOT disable that deliberate connect, and should not: a session is proof of the
 * account in a way a matching address is not. What it removes is the join that happens without
 * anyone asking.
 */
export type AccountLinkingMode = 'link' | 'block';

/**
 * Read the mode. Anything but an explicit `block` is `link`, INCLUDING absence — deliberately
 * the opposite convention to `ALLOW_SIGNUP` above, and the asymmetry is the point rather than
 * an oversight. `ALLOW_SIGNUP` defaults closed because opening it is a new decision nobody had
 * made. This key defaults to `link` because that is what every existing install already does
 * (it is Better Auth's default and was this issuer's only behaviour before the key existed),
 * and a setting that silently changes how people sign in on upgrade is worse than one that
 * has to be turned on. It is not merely compatibility: implicit linking here already requires
 * a vouched-for address on BOTH sides, which is the industry bar.
 */
export function accountLinkingMode(value: string | undefined): AccountLinkingMode {
  return value?.trim().toLowerCase() === 'block' ? 'block' : 'link';
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
