import type { SqlExec } from './introspect.js';
import { isPlaceholderAddress } from './placeholder-address.js';

/**
 * Joining a BankID placeholder account to the account the same person holds under a real
 * address (#2940). Callers have the person's proof of BOTH sides before they get here; this
 * module only decides which account survives, and does the moving.
 *
 * `sub` is `user.id`, so one `sub` retires, and which one is a question about who already knows
 * this person. `place_member` answers it: a retired `sub` that an app has bound would leave that
 * app holding a principal nobody can sign in to. So the bound side survives, whichever side it
 * is, and it takes the address with it. Both sides bound is two principals with their own data,
 * which only a rebind in the vertical could join, so that is refused and the apps are named.
 *
 * `place_member` holds what verticals report, for apps registered as places, so a binding in an
 * app that is not one cannot be seen here.
 */

interface AccountFacts {
  id: string;
  email: string;
  role: string | null;
  banned: number | null;
  phone_number: string | null;
}

export type MergeOutcome = { survivor: string } | { refused: string };

const factsOf = (sql: SqlExec, id: string): AccountFacts | undefined =>
  sql.exec('SELECT id, email, role, banned, phone_number FROM user WHERE id = ?', id).toArray()[0] as AccountFacts | undefined;

const appsOf = (sql: SqlExec, sub: string): string[] =>
  (
    sql
      .exec('SELECT a.name FROM place_member m JOIN place_app a ON a.app_scope_id = m.app_scope_id WHERE m.sub = ? ORDER BY a.name', sub)
      .toArray() as { name: string }[]
  ).map((row) => row.name);

/**
 * Merge `placeholderId` and `otherId`. Run inside one transaction: a throw anywhere must leave
 * both accounts as they were. Everything the retired account was signed in with ends here, and
 * no role is carried over, so a merge cannot widen anybody.
 */
export function mergeAccounts(sql: SqlExec, placeholderId: string, otherId: string, nowMs: number): MergeOutcome {
  const placeholder = factsOf(sql, placeholderId);
  const other = factsOf(sql, otherId);
  if (!placeholder || !other || placeholderId === otherId || !isPlaceholderAddress(placeholder.email)) {
    return { refused: 'These accounts cannot be joined' };
  }
  if (placeholder.banned || other.banned) return { refused: 'These accounts cannot be joined' };

  const placeholderApps = appsOf(sql, placeholderId);
  const otherApps = appsOf(sql, otherId);
  if (placeholderApps.length && otherApps.length) {
    return {
      refused: `Both accounts are in use (${[...new Set([...placeholderApps, ...otherApps])].sort().join(', ')}). Ask an administrator to join them.`,
    };
  }
  const survivor = placeholderApps.length ? placeholder : other;
  const retired = placeholderApps.length ? other : placeholder;
  if (retired.role === 'admin') return { refused: 'These accounts cannot be joined' };

  // A password row is keyed on the user's own id (`user-import.ts` writes the same shape).
  sql.exec(
    `UPDATE account SET user_id = ?, account_id = CASE WHEN provider_id = 'credential' THEN ? ELSE account_id END, updated_at = ?
     WHERE user_id = ?`,
    survivor.id, survivor.id, nowMs, retired.id,
  );
  sql.exec('UPDATE oauth_client SET user_id = ? WHERE user_id = ?', survivor.id, retired.id);
  // The OAuth tables do not cascade from `user`, and an access token references its refresh token.
  for (const table of ['oauth_access_token', 'oauth_refresh_token', 'oauth_consent', 'session']) {
    sql.exec(`DELETE FROM ${table} WHERE user_id = ?`, retired.id);
  }
  sql.exec('DELETE FROM user WHERE id = ?', retired.id);
  // After the delete: `user.email` is unique, and the retired row held the address until now.
  if (survivor === placeholder) {
    sql.exec(
      'UPDATE user SET email = ?, email_verified = 1, phone_number = COALESCE(phone_number, ?), updated_at = ? WHERE id = ?',
      other.email, other.phone_number, nowMs, survivor.id,
    );
  }
  return { survivor: survivor.id };
}
