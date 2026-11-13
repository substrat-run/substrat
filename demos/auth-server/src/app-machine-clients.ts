import type {
  EnsuredMachineClient,
  MachineClientEnsure,
  MachineClientRemove,
  RemovedMachineClient,
} from '@substrat-run/contracts';
import type { SqlExec } from './introspect.js';
import type { RegisterClientFn } from './preview-clients.js';

/**
 * An APP's machine client at this issuer (#3134) — the issuer's half of the protocol whose
 * vocabulary and reasoning live in `@substrat-run/contracts` (`machine-client.ts`).
 *
 * An app that declares issuer scopes gets ONE machine client here, registered by the platform
 * when the app is installed, so nobody registers it in the console, copies its secret by hand
 * or remembers to remove it. Two verbs, each platform-gated and addressed by this issuer's own
 * scope (the route and the DO refuse any other tenant's call before reaching here):
 *
 *   - **ensure** — register the app's client, or converge the one it has on the name and the
 *     scopes; on request, give it a new secret.
 *   - **remove** — delete the app's client and what it holds.
 *
 * ## How the client is registered
 *
 * The plugin creates a `client_credentials` client only for a signed-in administrator, and its
 * open registration refuses that grant. So the client is registered through the SAME dynamic
 * registration an install uses, which mints the id and hashes the secret, and is then given a
 * machine client's shape here: the one grant, no redirect URI, the scopes it may hold. That is
 * the row the console writes for a machine application, so an operator sees this client in
 * the console as one and can disable it there.
 *
 * ## Why no verb can reach another client
 *
 * Every verb reads its client from `app_machine_client`, by the app's scope, and nowhere else.
 * A client an operator registered, or one somebody registered dynamically, has no row there,
 * so no argument to either verb can select it.
 *
 * ## What an operator keeps
 *
 * The `MACHINE_SCOPES` ceiling bounds this client like any other: a declared scope outside it
 * is not granted, and is answered by name as `withheld`. `disabled` is the operator's too: an
 * ensure never re-enables a client an operator disabled. The scopes are not: an ensure sets
 * them back to the declared ones the ceiling allows, so the ceiling and `disabled` are the
 * operator's two levers, and an edit of the scope list in the console lasts until the next ensure.
 *
 * ## What a new secret ends, and what it does not
 *
 * A rotation keeps the client id, because the accounts a client provisioned through SCIM belong
 * to that id. From the rotation on, the old secret gets no new token. An access token issued
 * before it is a signed JWT the machine APIs verify without a stored row, so it stays valid
 * until it expires. Disabling or removing the client is what ends access at once: the machine
 * APIs read the client's row on every request.
 */

/** A redirect URI no client can be reached at. Registration requires one; the machine shape drops it. */
const UNUSED_REDIRECT_URI = 'https://machine-client.invalid/unused';

const NOW_MS = "cast(unixepoch('subsecond') * 1000 as integer)";

/** The registration the plugin accepts from an unauthenticated caller, for a confidential client. */
function registration(clientName: string): Record<string, unknown> {
  return {
    client_name: clientName,
    redirect_uris: [UNUSED_REDIRECT_URI],
    // The RFC 6749 default, and what the console registers a machine application with.
    token_endpoint_auth_method: 'client_secret_basic',
  };
}

/**
 * The client recorded for an app, or null. A row whose client is gone — an operator deleted it
 * on a runtime that does not enforce the cascade — is removed and read as none, so the next
 * ensure registers a new client instead of converging on nothing.
 */
function recordedClient(sql: SqlExec, appScopeId: string): string | null {
  const row = sql
    .exec(
      `SELECT m.client_id AS recorded, c.client_id AS present
         FROM app_machine_client m LEFT JOIN oauth_client c ON c.client_id = m.client_id
        WHERE m.app_scope_id = ?`,
      appScopeId,
    )
    .toArray()[0] as { recorded: string; present: string | null } | undefined;
  if (!row) return null;
  if (row.present) return row.present;
  sql.exec('DELETE FROM app_machine_client WHERE app_scope_id = ?', appScopeId);
  return null;
}

/**
 * Remove one client and what it holds, in the order `preview-clients.ts` documents: the tables
 * that reference `oauth_client` without a cascade first, then the record, then the client.
 */
function deleteClient(sql: SqlExec, clientId: string): void {
  for (const table of ['oauth_access_token', 'oauth_refresh_token', 'oauth_consent', 'oauth_client_resource']) {
    sql.exec(`DELETE FROM "${table}" WHERE client_id = ?`, clientId);
  }
  sql.exec('DELETE FROM app_machine_client WHERE client_id = ?', clientId);
  sql.exec('DELETE FROM oauth_client WHERE client_id = ?', clientId);
}

/** Set the name and the scopes the client holds. `disabled` is the operator's and is left alone. */
function converge(sql: SqlExec, clientId: string, clientName: string, granted: readonly string[]): void {
  sql.exec(
    `UPDATE oauth_client SET name = ?, client_credentials_scopes = ?, updated_at = ${NOW_MS} WHERE client_id = ?`,
    clientName,
    JSON.stringify(granted),
    clientId,
  );
}

/**
 * Ensure an app's machine client. `ceiling` is the issuer's `MACHINE_SCOPES`, read by the
 * caller for this request. The secret is answered only when this call registered the client or
 * rotated its secret; nothing here can answer it again.
 *
 * A new secret always comes from a registration, because only the plugin hashes one the way it
 * later verifies it. `transaction` wraps the synchronous work after that registration's await,
 * and re-reads the record inside it: another ensure for the same app may have landed meanwhile.
 * Whatever happens, the client just registered either becomes the app's client or is removed.
 */
export async function ensureMachineClient(
  sql: SqlExec,
  register: RegisterClientFn,
  input: MachineClientEnsure,
  ceiling: readonly string[],
  transaction: <T>(fn: () => T) => T,
): Promise<EnsuredMachineClient> {
  const granted = input.scopes.filter((s) => ceiling.includes(s));
  const withheld = input.scopes.filter((s) => !ceiling.includes(s));
  const answer = (clientId: string, clientSecret?: string): EnsuredMachineClient => ({
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    scopes: granted,
    withheld,
  });

  const before = transaction(() => {
    const clientId = recordedClient(sql, input.appScopeId);
    if (clientId && !input.rotate) converge(sql, clientId, input.clientName, granted);
    return clientId;
  });
  if (before && !input.rotate) return answer(before);

  const fresh = await register(registration(input.clientName));
  try {
    return transaction(() => {
      const current = recordedClient(sql, input.appScopeId);
      if (!current) {
        // The machine shape. `scopes` is what a person's sign-in may be granted, and the
        // registration filled it with the sign-in scopes: a machine client has no sign-in.
        sql.exec(
          `UPDATE oauth_client
              SET grant_types = '["client_credentials"]', response_types = '[]', redirect_uris = '[]',
                  scopes = '[]', client_credentials_scopes = ?, updated_at = ${NOW_MS}
            WHERE client_id = ?`,
          JSON.stringify(granted),
          fresh.client_id,
        );
        sql.exec(
          'INSERT INTO app_machine_client (app_scope_id, client_id) VALUES (?, ?)',
          input.appScopeId,
          fresh.client_id,
        );
        return answer(fresh.client_id, fresh.client_secret);
      }
      converge(sql, current, input.clientName, granted);
      if (!input.rotate) {
        // Another ensure registered the app's client while this one was registering. That one
        // answered the secret; this registration is surplus.
        deleteClient(sql, fresh.client_id);
        return answer(current);
      }
      // The rotation: the app's client takes the new registration's stored secret, and the
      // registration itself goes. Stored tokens of the old secret go with it.
      sql.exec(
        `UPDATE oauth_client
            SET client_secret = (SELECT client_secret FROM oauth_client WHERE client_id = ?), updated_at = ${NOW_MS}
          WHERE client_id = ?`,
        fresh.client_id,
        current,
      );
      sql.exec('DELETE FROM oauth_access_token WHERE client_id = ?', current);
      deleteClient(sql, fresh.client_id);
      return answer(current, fresh.client_secret);
    });
  } catch (e) {
    // The transaction rolled back, so the registration is still an ordinary client nothing
    // records: one no platform verb could remove later.
    transaction(() => deleteClient(sql, fresh.client_id));
    throw e;
  }
}

/**
 * Remove an app's machine client. Reads its target from `app_machine_client` alone. Synchronous
 * from first read to last write; the caller supplies the transaction.
 */
export function removeMachineClient(sql: SqlExec, input: MachineClientRemove): RemovedMachineClient {
  const clientId = recordedClient(sql, input.appScopeId);
  if (!clientId) return { removed: null };
  deleteClient(sql, clientId);
  return { removed: clientId };
}
