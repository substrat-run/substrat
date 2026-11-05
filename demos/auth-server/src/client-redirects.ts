import {
  CLIENT_REDIRECTS_CONFIG_PREFIX,
  clientRedirectUris,
  clientRedirects,
  oidcCallbackUrl,
  scopeId as scopeIdSchema,
  type ClientRedirects,
} from '@substrat-run/contracts';
import type { SqlExec } from './introspect.js';

/**
 * The PLATFORM's half of an app's client URIs at this issuer (#2904).
 *
 * An app's relying party sends the callback and the post-logout target of whatever hostname
 * it was reached on, and the plugin matches both exactly. Install registers the default
 * hostname by open DCR, which can set neither the other hostnames nor `enable_end_session`
 * (the plugin refuses an RP-initiated logout from a client without it). So the dashboard
 * delivers each app's active hostnames (`substrat:redirects:<app scope>`, see
 * `@substrat-run/contracts`' `client-redirects.ts`) through the platform-gated
 * `/internal/configure`, and this keeps the client in step.
 *
 * ## What the platform owns on a client
 *
 * Only the URIs it derived from the hostnames it delivered last, recorded in
 * `platform_client_redirects`. A delivery removes those, adds the new set's, and leaves every
 * other URI on the client as it found it, so a callback an operator added by hand survives
 * every delivery. A first delivery for an existing install has nothing recorded, so it only
 * adds.
 *
 * ## Which client a delivery may touch
 *
 * The one recorded for the app, or, for a first delivery or a new client, one that already
 * redirects to the callback of a delivered hostname: install registered the default one, so
 * the app's own client always qualifies, and the console's client or a stranger's DCR
 * client never does. Anything else refuses the delivery, which the dashboard logs and
 * retries.
 */

export function isClientRedirectsEntry(key: string): boolean {
  return key.startsWith(CLIENT_REDIRECTS_CONFIG_PREFIX);
}

/** One app's desired state: its client and hostnames, or `null` to un-register. */
export interface ClientRedirectsDelivery {
  appScopeId: string;
  target: ClientRedirects | null;
}

/** What one sync did, for the log line and the tests. */
export interface ClientRedirectsSync {
  app: string;
  clientId: string | null;
  added: string[];
  removed: string[];
}

/** A delivered entry, validated. Throws on anything malformed, so a bad one refuses the whole call. */
export function parseClientRedirectsEntry(key: string, value: string): ClientRedirectsDelivery {
  const appScopeId = scopeIdSchema.parse(key.slice(CLIENT_REDIRECTS_CONFIG_PREFIX.length));
  if (value.trim() === '') return { appScopeId, target: null };
  const target = clientRedirects.parse(JSON.parse(value));
  return { appScopeId, target: { ...target, hostnames: [...new Set(target.hostnames)] } };
}

interface ClientLists {
  redirect_uris: string | null;
  post_logout_redirect_uris: string | null;
  enable_end_session: number | null;
}

const list = (raw: string | null): string[] => {
  try {
    const parsed: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
};

function readClient(sql: SqlExec, clientId: string): ClientLists | undefined {
  return sql
    .exec('SELECT redirect_uris, post_logout_redirect_uris, enable_end_session FROM oauth_client WHERE client_id = ?', clientId)
    .toArray()[0] as ClientLists | undefined;
}

/**
 * Rewrite one client's two lists: drop what `remove` derives, add what `add` derives, keep
 * the rest in its order. `endSession` turns RP-initiated logout on for a client the platform
 * manages. Returns the URIs that actually changed.
 */
function rewrite(
  sql: SqlExec,
  clientId: string,
  client: ClientLists,
  remove: readonly string[],
  add: readonly string[],
  endSession: boolean,
  nowMs: number,
): { added: string[]; removed: string[] } {
  const gone = clientRedirectUris(remove);
  const wanted = clientRedirectUris(add);
  const next = (current: string[], drop: string[], put: string[]) => {
    const kept = current.filter((u) => !drop.includes(u) || put.includes(u));
    return [...kept, ...put.filter((u) => !kept.includes(u))];
  };
  const redirects = list(client.redirect_uris);
  const logouts = list(client.post_logout_redirect_uris);
  const nextRedirects = next(redirects, gone.redirectUris, wanted.redirectUris);
  const nextLogouts = next(logouts, gone.postLogoutRedirectUris, wanted.postLogoutRedirectUris);
  const before = [...redirects, ...logouts];
  const after = [...nextRedirects, ...nextLogouts];
  const delta = { added: after.filter((u) => !before.includes(u)), removed: before.filter((u) => !after.includes(u)) };
  if (!delta.added.length && !delta.removed.length && (!endSession || client.enable_end_session)) return delta;
  sql.exec(
    `UPDATE oauth_client SET redirect_uris = ?, post_logout_redirect_uris = ?, updated_at = ?
       ${endSession ? ', enable_end_session = 1' : ''}
     WHERE client_id = ?`,
    JSON.stringify(nextRedirects),
    JSON.stringify(nextLogouts),
    nowMs,
    clientId,
  );
  return delta;
}

/**
 * Make the app's client carry exactly the delivered hostnames' URIs, beside whatever else it
 * carries. Synchronous from first read to last write; the caller owns the transaction (the
 * DO runs this inside `storage.transactionSync` with the rest of the delivery), so a refusal
 * thrown here rolls back a client change's first half too.
 */
export function syncClientRedirects(sql: SqlExec, delivery: ClientRedirectsDelivery, nowMs: number): ClientRedirectsSync {
  const { appScopeId, target } = delivery;
  const result: ClientRedirectsSync = { app: appScopeId, clientId: target?.clientId ?? null, added: [], removed: [] };
  const recorded = sql
    .exec('SELECT client_id, hostnames FROM platform_client_redirects WHERE app_scope_id = ?', appScopeId)
    .toArray()[0] as { client_id: string; hostnames: string } | undefined;
  const previous = recorded ? list(recorded.hostnames) : [];
  const sameClient = recorded !== undefined && recorded.client_id === target?.clientId;

  // The client the platform is leaving: an un-registration, or an Identity change that
  // registered a new one. A client an operator deleted meanwhile has nothing left to clean.
  if (recorded && !sameClient) {
    const old = readClient(sql, recorded.client_id);
    if (old) result.removed.push(...rewrite(sql, recorded.client_id, old, previous, [], false, nowMs).removed);
    sql.exec('DELETE FROM platform_client_redirects WHERE app_scope_id = ?', appScopeId);
  }
  if (!target) return result;

  const client = readClient(sql, target.clientId);
  if (!client) throw new Error(`${appScopeId}: client ${target.clientId} does not exist at this issuer`);
  if (!sameClient) {
    const callbacks = new Set(list(client.redirect_uris));
    if (!target.hostnames.some((h) => callbacks.has(oidcCallbackUrl(h)))) {
      throw new Error(`${appScopeId}: client ${target.clientId} redirects to none of the app's hostnames — not adopted`);
    }
  }
  const changed = rewrite(sql, target.clientId, client, sameClient ? previous : [], target.hostnames, true, nowMs);
  result.added.push(...changed.added);
  result.removed.push(...changed.removed);
  const hostnames = JSON.stringify(target.hostnames);
  if (sameClient && recorded.hostnames === hostnames) return result;
  sql.exec(
    `INSERT INTO platform_client_redirects (app_scope_id, client_id, hostnames, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (app_scope_id) DO UPDATE SET client_id = excluded.client_id, hostnames = excluded.hostnames,
       updated_at = excluded.updated_at`,
    appScopeId,
    target.clientId,
    hostnames,
    nowMs,
  );
  return result;
}
