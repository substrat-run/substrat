import type { SqlExec } from './introspect.js';

/**
 * Deleting a person (#3346): everything that identifies them, in an order the store accepts.
 *
 * Better Auth's own `admin/remove-user` cannot do this, and it used to be what the console
 * called. It deletes `session`, then `account`, then `user`, as three statements with no
 * transaction — and `@better-auth/oauth-provider`'s tables reference `user(id)` WITHOUT
 * `ON DELETE CASCADE`. Both runtimes enforce foreign keys, so for anybody who had ever signed in
 * to a relying party the last statement was refused after the first two had committed: a 500,
 * a person with no way in who was still listed, and a refresh token that went on minting tokens
 * for them at every app they had used. The plugin declares those keys, so the fix is the order
 * here rather than a schema change; `scim.ts` and `account-merge.ts` already deleted this way.
 *
 * What goes, and why each row:
 *  - `oauth_access_token`, `oauth_refresh_token` — revocation, not tidying. `userinfo`,
 *    introspection and the refresh grant each authenticate a token against its own row, so a
 *    row outliving the person is a credential that still works. Access first: it references its
 *    refresh token.
 *  - `oauth_consent` — a standing "yes" for an app, and a row naming the person.
 *  - `session` — the cookie is looked up on every request (no cookie cache), so the person's
 *    browser is signed out on its next request.
 *  - `account` — every sign-in method: the password hash, the upstreams' subjects and tokens,
 *    the BankID personal number.
 *  - `verification` — the person's pending one-time rows (a password reset or an invitation
 *    holds their id as its value, a GitHub address step inside its JSON, a phone attempt or an
 *    invitation's password cooldown in its key). Matched on the id, never the address: an
 *    address can be a substring of somebody else's, a random 32-character id is not.
 *  - `place_member` — which apps bound this `sub`. The binding is the app's to drop; this is
 *    only the issuer's index of it, and an index of a person who is gone is a row about them.
 *  - `user_activity`, `user_client_activity`, `scim_user` — cascade from `user` already, and
 *    deleted by name anyway, so the erasure does not depend on a runtime enforcing them.
 *
 * What stays, and why:
 *  - `oauth_client` a person registered keeps existing with `user_id` cleared. The client
 *    belongs to whoever runs the app; deleting it would break that app for everybody else.
 *  - `sign_in_attempt` rows keep what happened and lose who: `user_id` is cleared. The log is
 *    the operator's record of the issuer's behaviour, its counts are the Overview's chart, and it
 *    prunes itself after `SIGN_IN_LOG_RETENTION` anyway.
 *
 * A JWT access token (one minted for a registered API) is self-contained: a resource server
 * that verifies it locally, without introspection, accepts it until it expires. Nothing an
 * issuer stores can recall one; the row deleted here is what makes introspection refuse it.
 *
 * Run inside one transaction: a throw anywhere must leave the person as they were.
 */
export function eraseUser(sql: SqlExec, userId: string): void {
  sql.exec(
    `DELETE FROM oauth_access_token
      WHERE user_id = ? OR refresh_id IN (SELECT id FROM oauth_refresh_token WHERE user_id = ?)`,
    userId,
    userId,
  );
  for (const table of ['oauth_refresh_token', 'oauth_consent', 'session', 'account']) {
    sql.exec(`DELETE FROM ${table} WHERE user_id = ?`, userId);
  }
  sql.exec('UPDATE oauth_client SET user_id = NULL WHERE user_id = ?', userId);
  // `instr`, not LIKE: a pattern built from input is held to a Durable Object's 50-byte limit.
  sql.exec('DELETE FROM verification WHERE instr(value, ?) > 0 OR instr(identifier, ?) > 0', userId, userId);
  sql.exec('DELETE FROM place_member WHERE sub = ?', userId);
  for (const table of ['user_activity', 'user_client_activity', 'scim_user']) {
    sql.exec(`DELETE FROM ${table} WHERE user_id = ?`, userId);
  }
  sql.exec('UPDATE sign_in_attempt SET user_id = NULL WHERE user_id = ?', userId);
  sql.exec('DELETE FROM user WHERE id = ?', userId);
}

export type AdminErasure = { erased: string } | { refused: string; status: 404 | 409 };

/**
 * An administrator deleting somebody. Two refusals, both about losing the ability to administer
 * the issuer at all:
 *
 *  - Not your own account. A console that lets you remove yourself is one misclick from an
 *    issuer you are no longer signed in to, and possibly one nobody can administer.
 *  - Not the last administrator. Through the console this follows from the first (the caller is
 *    an administrator, and is not the one being deleted), so it holds for any other door that
 *    reaches here with a caller who is not one — a machine caller, say.
 */
export function adminEraseUser(sql: SqlExec, userId: string, actorSub: string): AdminErasure {
  const row = sql.exec('SELECT id, role FROM user WHERE id = ?', userId).toArray()[0] as { id: string; role: string | null } | undefined;
  if (!row) return { refused: `unknown user '${userId}'`, status: 404 };
  if (userId === actorSub) {
    return { refused: 'you cannot delete your own account — another administrator has to', status: 409 };
  }
  if (row.role === 'admin') {
    const others = sql.exec("SELECT count(*) AS n FROM user WHERE role = 'admin' AND id != ?", userId).toArray()[0] as { n: number };
    if (others.n === 0) return { refused: 'this is the last administrator — make somebody else one first', status: 409 };
  }
  eraseUser(sql, userId);
  return { erased: userId };
}
