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
 *  - `verification` — the person's pending one-time rows, each matched to them exactly by the
 *    shape its flow writes (`ownedVerificationRows`). Never by substring: an imported id is any
 *    string the previous issuer used, so a short one is part of other people's keys and values.
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
  // Before the sessions go: a phone challenge is keyed by the session, not the person.
  for (const id of ownedVerificationRows(sql, userId)) sql.exec('DELETE FROM verification WHERE id = ?', id);
  for (const table of ['oauth_refresh_token', 'oauth_consent', 'session', 'account']) {
    sql.exec(`DELETE FROM ${table} WHERE user_id = ?`, userId);
  }
  sql.exec('UPDATE oauth_client SET user_id = NULL WHERE user_id = ?', userId);
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

interface VerificationRow {
  id: string;
  identifier: string;
  value: string;
}

/** A key a flow builds from the person's id alone. */
const ID_KEYS = ['invite-password:', 'phone-enrollment:', 'phone-send:'];
/** A key a flow builds from the person's id and trailing counters — the id is what precedes them. */
const COUNTED_KEYS: [prefix: string, counters: RegExp][] = [
  ['phone-attempt:', /^(.*):\d+:\d+$/],
  ['bankid-email-skip:', /^(.*):\d+$/],
];

/** The person named in a row's JSON value: a GitHub address step, a BankID email step or order, an OAuth link. */
function jsonOwner(value: string): unknown[] {
  if (!value.startsWith('{')) return [];
  try {
    const v = JSON.parse(value) as { userId?: unknown; linkUserId?: unknown; link?: { userId?: unknown } };
    return [v.userId, v.linkUserId, v.link?.userId];
  } catch {
    return [];
  }
}

function owns(row: VerificationRow, userId: string): boolean {
  if (row.value === userId) return true; // a password reset, an invitation
  if (ID_KEYS.some((prefix) => row.identifier === `${prefix}${userId}`)) return true;
  for (const [prefix, counters] of COUNTED_KEYS) {
    if (row.identifier.startsWith(prefix) && counters.exec(row.identifier.slice(prefix.length))?.[1] === userId) return true;
  }
  return jsonOwner(row.value).includes(userId);
}

/**
 * The `verification` rows that are this person's, by row id. `instr` only narrows the read to rows
 * that mention the id somewhere; `owns` is the decision, and it compares whole values. Then the
 * rows that never name the person: a phone challenge, keyed by one of their sessions, and the rows
 * hanging off an owned step — a GitHub address proof (its JSON names the step's key), a BankID
 * email challenge and its send counters (keyed by the step's token digest).
 */
function ownedVerificationRows(sql: SqlExec, userId: string): string[] {
  const owned = (
    sql
      .exec('SELECT id, identifier, value FROM verification WHERE instr(value, ?) > 0 OR instr(identifier, ?) > 0', userId, userId)
      .toArray() as unknown as VerificationRow[]
  ).filter((row) => owns(row, userId));
  const ids = owned.map((row) => row.id);
  const byIdentifier = (identifier: string) =>
    (sql.exec('SELECT id FROM verification WHERE identifier = ?', identifier).toArray() as { id: string }[]).map((r) => r.id);
  const sessions = sql.exec('SELECT id FROM session WHERE user_id = ?', userId).toArray() as { id: string }[];
  for (const { id } of sessions) ids.push(...byIdentifier(`phone-challenge:${id}`));
  for (const row of owned) {
    if (row.identifier.startsWith('github-email:')) {
      const proofs = sql
        .exec("SELECT id, identifier, value FROM verification WHERE substr(identifier, 1, 19) = 'github-email-proof:' AND instr(value, ?) > 0", row.identifier)
        .toArray() as unknown as VerificationRow[];
      for (const proof of proofs) {
        try {
          if ((JSON.parse(proof.value) as { pendingKey?: unknown }).pendingKey === row.identifier) ids.push(proof.id);
        } catch {
          /* not a proof this step wrote */
        }
      }
    }
    if (row.identifier.startsWith('bankid-email:')) {
      const hash = row.identifier.slice('bankid-email:'.length);
      ids.push(...byIdentifier(`bankid-email-challenge:${hash}`));
      const sends = `bankid-email-sends:${hash}:`;
      ids.push(
        ...(
          sql.exec('SELECT id FROM verification WHERE substr(identifier, 1, ?) = ?', sends.length, sends).toArray() as { id: string }[]
        ).map((r) => r.id),
      );
    }
  }
  return [...new Set(ids)];
}
