import {
  clientRedirectUris,
  type EnsuredManagedClient,
  type ManagedClientEnsure,
  type ManagedClientRemove,
  type RemovedManagedClient,
} from '@substrat-run/contracts';
import type { SqlExec } from './introspect.js';
import { PreviewClientRefusal, type RegisterClientFn } from './preview-clients.js';
import { syncClientRedirects } from './client-redirects.js';

/**
 * A MANAGED tenant's sign-in client at this issuer (#3202, D-72, #3261) — the issuer's half of
 * the protocol whose vocabulary and reasoning live in `@substrat-run/contracts`
 * (`managed-client.ts`).
 *
 * A tenant a manager provisioned through `provision-tenant` may sign in here, at one of the
 * manager's own team auth-servers. The platform registers its client through these two verbs,
 * each platform-gated and addressed by this issuer's own scope (the route and the DO refuse any
 * other tenant's call before reaching here):
 *
 *   - **ensure** — register the managed app's client, or give the one recorded for it a new
 *     secret. A retry of the provision finds the client its first pass registered, so a
 *     provision that was retried ends with ONE client here, not one per attempt.
 *   - **remove** — delete the client and what it holds, and the app's place and redirect
 *     record here, so a person's account page stops listing a business that has ended.
 *
 * ## How the client is registered
 *
 * Through the same in-process dynamic registration an install's client takes, so the plugin
 * mints the id, hashes the secret and judges the URIs, with exactly the URIs the app's hostname
 * derives (`clientRedirectUris`). The client is then recorded in `managed_client`, keyed by the
 * managed app's scope.
 *
 * ## Why no verb can reach another client
 *
 * Every verb reads its client from `managed_client`, by the managed app's scope, and nowhere
 * else. A client an operator registered, one somebody registered dynamically, an installed app's
 * client and a machine client have no row there, so no argument to either verb can select one.
 * The place a remove clears is the `place_app` row for that scope under the managed tenant's
 * own key, which only the platform's `provision-tenant` delivery writes, and the members it
 * clears are those reported under that row: another app's entries, and so another person's
 * list of other businesses, are never touched.
 *
 * ## What a new secret ends, and what it does not
 *
 * A new secret keeps the client id, so the place and the redirect record the platform delivered
 * for it stay valid. The old secret gets no new token from then on. Tokens already issued are
 * left alone: the only caller of a second ensure is a retried provision, which delivers the new
 * secret to the managed scope at once.
 */

const NOW_MS = "cast(unixepoch('subsecond') * 1000 as integer)";

/** The registration the plugin accepts from an unauthenticated caller, for the app's hostname. */
function registration(input: ManagedClientEnsure): Record<string, unknown> {
  const uris = clientRedirectUris([input.hostname]);
  return {
    client_name: input.clientName,
    redirect_uris: uris.redirectUris,
    post_logout_redirect_uris: uris.postLogoutRedirectUris,
    // How the relying party presents the secret (oidc-rp sends it in the token-request body).
    token_endpoint_auth_method: 'client_secret_post',
  };
}

/**
 * The client recorded for a managed app, or null. A row whose client is gone (an operator deleted
 * it on a runtime that does not enforce the cascade) is removed and read as none, so the next
 * ensure registers a new client instead of answering one that no longer exists.
 */
function recordedClient(sql: SqlExec, appScopeId: string, appTenantId: string): string | null {
  const row = sql
    .exec(
      `SELECT m.client_id AS recorded, m.app_tenant_id AS tenant, c.client_id AS present
         FROM managed_client m LEFT JOIN oauth_client c ON c.client_id = m.client_id
        WHERE m.app_scope_id = ?`,
      appScopeId,
    )
    .toArray()[0] as { recorded: string; tenant: string; present: string | null } | undefined;
  if (!row) return null;
  // A scope id is the platform's ULID and belongs to one tenant, so a call pairing it with
  // another is a platform bug: refused, and nothing is touched.
  if (row.tenant !== appTenantId) {
    throw new PreviewClientRefusal(409, `scope ${appScopeId} is recorded here for another managed tenant`);
  }
  if (row.present) return row.present;
  sql.exec('DELETE FROM managed_client WHERE app_scope_id = ?', appScopeId);
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
  sql.exec('DELETE FROM managed_client WHERE client_id = ?', clientId);
  sql.exec('DELETE FROM oauth_client WHERE client_id = ?', clientId);
}

const list = (raw: unknown): string[] => {
  try {
    const parsed: unknown = JSON.parse(typeof raw === 'string' ? raw : '[]');
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
};

/**
 * Set the recorded client's name and make sure it still carries the hostname's URIs, adding any
 * that are missing and leaving every other URI as it is: the platform's redirects delivery owns
 * the other hostnames' URIs, and an operator may have added some of their own.
 */
function converge(sql: SqlExec, clientId: string, input: ManagedClientEnsure): void {
  const row = sql
    .exec('SELECT redirect_uris, post_logout_redirect_uris FROM oauth_client WHERE client_id = ?', clientId)
    .toArray()[0] as { redirect_uris: unknown; post_logout_redirect_uris: unknown };
  const wanted = clientRedirectUris([input.hostname]);
  const merge = (current: string[], add: string[]) => [...current, ...add.filter((u) => !current.includes(u))];
  sql.exec(
    `UPDATE oauth_client SET name = ?, redirect_uris = ?, post_logout_redirect_uris = ?, updated_at = ${NOW_MS} WHERE client_id = ?`,
    input.clientName,
    JSON.stringify(merge(list(row.redirect_uris), wanted.redirectUris)),
    JSON.stringify(merge(list(row.post_logout_redirect_uris), wanted.postLogoutRedirectUris)),
    clientId,
  );
}

/**
 * Ensure a managed app's sign-in client, and answer its secret.
 *
 * A new secret always comes from a registration, because only the plugin hashes one the way it
 * later verifies it. `transaction` wraps the synchronous work after that registration's await,
 * and re-reads the record inside it: another ensure for the same app may have landed meanwhile.
 * Whatever happens, the client just registered either becomes the app's client, lends the
 * recorded one its secret and goes, or is removed.
 */
export async function ensureManagedClient(
  sql: SqlExec,
  register: RegisterClientFn,
  input: ManagedClientEnsure,
  transaction: <T>(fn: () => T) => T,
): Promise<EnsuredManagedClient> {
  const fresh = await register(registration(input));
  try {
    return transaction(() => {
      const current = recordedClient(sql, input.appScopeId, input.appTenantId);
      if (!current) {
        sql.exec(
          'INSERT INTO managed_client (app_scope_id, app_tenant_id, client_id) VALUES (?, ?, ?)',
          input.appScopeId,
          input.appTenantId,
          fresh.client_id,
        );
        return { clientId: fresh.client_id, clientSecret: fresh.client_secret, registered: true };
      }
      // The recorded client takes the new registration's stored secret, keeping its id, and the
      // registration itself goes.
      converge(sql, current, input);
      sql.exec(
        `UPDATE oauth_client
            SET client_secret = (SELECT client_secret FROM oauth_client WHERE client_id = ?), updated_at = ${NOW_MS}
          WHERE client_id = ?`,
        fresh.client_id,
        current,
      );
      deleteClient(sql, fresh.client_id);
      return { clientId: current, clientSecret: fresh.client_secret, registered: false };
    });
  } catch (e) {
    // The transaction rolled back, so the registration is still an ordinary client nothing
    // records: one no platform verb could remove later.
    transaction(() => deleteClient(sql, fresh.client_id));
    throw e;
  }
}

/**
 * Remove a managed app's client, its place under the managed tenant's own key, and the
 * platform's redirect record for its scope. Synchronous from first read to last write; the caller
 * supplies the transaction. The place and the record go even when no client is recorded, which
 * is the case for an app registered before this protocol, whose client the platform never
 * recorded and so does not delete. Repeating it changes nothing.
 */
export function removeManagedClient(sql: SqlExec, input: ManagedClientRemove, nowMs: number): RemovedManagedClient {
  // First, so a call pairing the scope with another tenant is refused before anything is written.
  const clientId = recordedClient(sql, input.appScopeId, input.appTenantId);
  const place = sql
    .exec('SELECT 1 AS hit FROM place_app WHERE app_scope_id = ? AND tenant_id = ?', input.appScopeId, input.appTenantId)
    .toArray();
  if (place.length) {
    sql.exec('DELETE FROM place_member WHERE app_scope_id = ?', input.appScopeId);
    sql.exec('DELETE FROM place_app WHERE app_scope_id = ? AND tenant_id = ?', input.appScopeId, input.appTenantId);
  }
  // Takes the platform's URIs off whichever client the record names, and drops the record.
  syncClientRedirects(sql, { appScopeId: input.appScopeId, target: null }, nowMs);
  if (clientId) deleteClient(sql, clientId);
  return { removed: clientId, unlisted: place.length > 0 };
}
