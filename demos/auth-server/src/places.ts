import {
  PLACES_CONFIG_PREFIX,
  place,
  placeRegistrations,
  tenantId as tenantIdSchema,
  type Place,
  type PlaceRegistration,
  type PlaceReport,
} from '@substrat-run/contracts';
import type { SqlExec } from './introspect.js';

/**
 * A login's PLACES, kept by the identity pool that mints its `sub` (#1670).
 *
 * This issuer is the pool. Its users live in this DO's SQLite, and every app that signs in
 * here does so as one of its OIDC clients. So "where does this login hold a principal" is
 * answered here, keyed on the `sub` this issuer minted (K-23, K-25), and shown only on
 * this issuer's origin, to the session it belongs to. Verticals never read it, which is what
 * keeps D-40 intact: no vertical gains a channel to anything but the issuer it already posts
 * to at `/oauth2/token`.
 *
 * ## Two tables, two writers
 *
 *   - `place_app` — which apps are places at all, with their tenant, hostname and name. ONLY
 *     the platform writes it, through the platform-gated `/internal/configure`
 *     (`substrat:places:<tenant id>` = that team's whole set, see `@substrat-run/contracts`).
 *   - `place_member` — which `sub` is bound in which app. The app's vertical writes it,
 *     authenticated as the OIDC client the platform registered for it.
 *
 * An entry is the join, projected to exactly `place` from contracts. Neither writer can supply
 * the other's half.
 *
 * ## Why a vertical cannot poison someone else's list
 *
 * Open dynamic registration means anybody can hold credentials for SOME client of this
 * issuer, so client credentials alone prove nothing. A report is kept only past three checks,
 * each against this issuer's own records rather than the reporter's word:
 *
 *   1. **The client is a registered place.** No `place_app` row names it ⇒ 403. An open-DCR or
 *      MCP client never has one, because only the platform writes that table.
 *   2. **The client authenticates**, through this issuer's own RFC 7662 endpoint, which runs
 *      the plugin's client authentication exactly as `/oauth2/token` does. A rotated or
 *      disabled client is refused the same way. It then writes only under its own app, so it
 *      cannot touch another app's entries.
 *   3. **An addition needs issuance.** A `sub` is added only if this issuer has itself issued
 *      to that client for that `sub` (a consent, access-token or refresh-token row). So a
 *      client can put its app into the list of a login that signed in to it, and nobody
 *      else's. A removal needs no such evidence: it can only remove the caller's own rows.
 *
 * Every per-subject outcome answers the same `204`, so the report channel is an oracle for
 * nothing. The refusals that differ (malformed, bad credentials, unregistered, wrong scope)
 * depend only on the caller's own request and credentials.
 */

/** A delivered entry that registers a team's apps. */
export function isPlacesEntry(key: string): boolean {
  return key.startsWith(PLACES_CONFIG_PREFIX);
}

/** One team's desired set, parsed and validated. */
export interface PlacesDelivery {
  tenantId: string;
  registrations: PlaceRegistration[];
}

/**
 * A delivered entry, validated. Throws on anything malformed, and the caller parses every
 * entry of a delivery before writing any, so a bad one refuses the whole call (400).
 * Duplicate app scopes or client ids inside one delivery are refused too: which of the two
 * would win is not a question this should answer by accident.
 */
export function parsePlacesEntry(key: string, value: string): PlacesDelivery {
  const tenantId = tenantIdSchema.parse(key.slice(PLACES_CONFIG_PREFIX.length));
  if (value.trim() === '') return { tenantId, registrations: [] };
  const registrations = placeRegistrations.parse(JSON.parse(value));
  const scopes = new Set(registrations.map((r) => r.appScopeId));
  const clients = new Set(registrations.map((r) => r.clientId));
  if (scopes.size !== registrations.length) throw new Error(`${key} names an app scope twice`);
  if (clients.size !== registrations.length) throw new Error(`${key} names a client id twice`);
  return { tenantId, registrations };
}

/** What one sync did, for a caller that logs it and a test that pins it. */
export interface PlacesSync {
  registered: string[];
  updated: string[];
  cleared: string[];
}

interface AppRow {
  app_scope_id: string;
  tenant_id: string;
  client_id: string;
  hostname: string;
  name: string;
}

/** Drop one app: its registration and every entry under it. */
function dropApp(sql: SqlExec, appScopeId: string): void {
  sql.exec('DELETE FROM place_member WHERE app_scope_id = ?', appScopeId);
  sql.exec('DELETE FROM place_app WHERE app_scope_id = ?', appScopeId);
}

/**
 * Make one team's registrations exactly `registrations`.
 *
 *   - An app the team no longer names (deleted, or signing in elsewhere now) is dropped, with
 *     every entry under it. That is how a removed app leaves every list at once.
 *   - A hostname or name change updates in place; the entries follow, since they are joins.
 *   - A CLIENT change drops the app's entries. They were admitted on evidence of issuance to
 *     the old client, and the new one re-earns them as its users sign in.
 *   - A registration held by ANOTHER team for the same app scope or client id is taken over.
 *     A scope has one tenant and a client one app, so the older claim is stale.
 *
 * Synchronous from first read to last write; the caller owns the transaction (the DO runs
 * this inside `storage.transactionSync` with the rest of the delivery).
 */
export function syncPlaceRegistrations(sql: SqlExec, delivery: PlacesDelivery, nowMs: number): PlacesSync {
  const { tenantId, registrations } = delivery;
  const result: PlacesSync = { registered: [], updated: [], cleared: [] };
  const wanted = new Map<string, PlaceRegistration>(registrations.map((r) => [r.appScopeId, r]));

  const mine = sql
    .exec('SELECT app_scope_id, tenant_id, client_id, hostname, name FROM place_app WHERE tenant_id = ?', tenantId)
    .toArray() as unknown as AppRow[];
  for (const row of mine) {
    if (wanted.has(row.app_scope_id)) continue;
    dropApp(sql, row.app_scope_id);
    result.cleared.push(row.app_scope_id);
  }

  for (const reg of registrations) {
    // Another team's stale claim on this scope or this client — never this team's own row
    // for the same app, which is updated below.
    const stale = sql
      .exec(
        'SELECT app_scope_id FROM place_app WHERE (app_scope_id = ? AND tenant_id <> ?) OR (client_id = ? AND app_scope_id <> ?)',
        reg.appScopeId,
        tenantId,
        reg.clientId,
        reg.appScopeId,
      )
      .toArray() as unknown as Pick<AppRow, 'app_scope_id'>[];
    for (const s of stale) dropApp(sql, s.app_scope_id);

    const current = (
      sql
        .exec('SELECT app_scope_id, tenant_id, client_id, hostname, name FROM place_app WHERE app_scope_id = ?', reg.appScopeId)
        .toArray() as unknown as AppRow[]
    )[0];
    if (!current) {
      sql.exec(
        'INSERT INTO place_app (app_scope_id, tenant_id, client_id, hostname, name, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        reg.appScopeId,
        tenantId,
        reg.clientId,
        reg.hostname,
        reg.name,
        nowMs,
      );
      result.registered.push(reg.appScopeId);
      continue;
    }
    if (current.client_id === reg.clientId && current.hostname === reg.hostname && current.name === reg.name) continue;
    if (current.client_id !== reg.clientId) sql.exec('DELETE FROM place_member WHERE app_scope_id = ?', reg.appScopeId);
    sql.exec(
      'UPDATE place_app SET client_id = ?, hostname = ?, name = ?, updated_at = ? WHERE app_scope_id = ?',
      reg.clientId,
      reg.hostname,
      reg.name,
      nowMs,
      reg.appScopeId,
    );
    result.updated.push(reg.appScopeId);
  }
  return result;
}

/**
 * THE read: the places of one `sub`, and nothing else. Its only parameter is the subject,
 * and its only caller takes that from the signed-in session, so there is no request shape in
 * which it answers for someone else. Each row is parsed through `place` on the way out, which
 * is what holds the entry to exactly its four keys.
 */
export function placesOf(sql: SqlExec, sub: string): Place[] {
  const rows = sql
    .exec(
      `SELECT a.tenant_id AS tenantId, a.app_scope_id AS scopeId, a.hostname AS hostname, a.name AS name
         FROM place_member m JOIN place_app a ON a.app_scope_id = m.app_scope_id
        WHERE m.sub = ?
        ORDER BY a.name, a.app_scope_id`,
      sub,
    )
    .toArray();
  return rows.map((r) => place.parse(r));
}

/** The app a client is registered for, or undefined when it is not a place. */
export function registrationOfClient(
  sql: SqlExec,
  clientId: string,
): { appScopeId: string; tenantId: string } | undefined {
  const row = (
    sql.exec('SELECT app_scope_id, tenant_id FROM place_app WHERE client_id = ?', clientId).toArray() as unknown as Pick<
      AppRow,
      'app_scope_id' | 'tenant_id'
    >[]
  )[0];
  return row ? { appScopeId: row.app_scope_id, tenantId: row.tenant_id } : undefined;
}

/**
 * The subjects this issuer has itself issued to `clientId` for: a consent the user gave it, or
 * an access or refresh token minted to it. The issuer's own record of who signed in to that
 * client, which is what an addition is held to. One query, so a whole-set repair costs the
 * same three index reads however many subjects it names.
 */
export function subjectsIssuedTo(sql: SqlExec, clientId: string): Set<string> {
  const rows = sql
    .exec(
      `SELECT user_id FROM oauth_consent WHERE client_id = ? AND user_id IS NOT NULL
       UNION SELECT user_id FROM oauth_access_token WHERE client_id = ? AND user_id IS NOT NULL
       UNION SELECT user_id FROM oauth_refresh_token WHERE client_id = ? AND user_id IS NOT NULL`,
      clientId,
      clientId,
      clientId,
    )
    .toArray() as { user_id: string }[];
  return new Set(rows.map((r) => r.user_id));
}

/** Has this issuer issued to `clientId` for `sub`? The single-subject form of the above. */
export function hasIssuedTo(sql: SqlExec, clientId: string, sub: string): boolean {
  return (
    sql
      .exec(
        `SELECT 1 FROM oauth_consent WHERE client_id = ? AND user_id = ?
         UNION ALL SELECT 1 FROM oauth_access_token WHERE client_id = ? AND user_id = ?
         UNION ALL SELECT 1 FROM oauth_refresh_token WHERE client_id = ? AND user_id = ?
         LIMIT 1`,
        clientId,
        sub,
        clientId,
        sub,
        clientId,
        sub,
      )
      .toArray().length > 0
  );
}

/** What a report did, for the log line. Never part of the response. */
export interface PlaceReportOutcome {
  added: number;
  removed: number;
  /** Subjects named for addition that this issuer never issued to the client for. */
  dropped: number;
}

/**
 * Apply an AUTHENTICATED report from the client registered for `appScopeId`. Every write is
 * scoped to that app, so nothing here can reach another app's rows.
 *
 * `replace` is the repair: afterwards the app's entries are exactly the named subjects this
 * issuer has issued to the client for. Synchronous; the caller owns the transaction.
 */
export function applyPlaceReport(
  sql: SqlExec,
  appScopeId: string,
  clientId: string,
  report: PlaceReport,
): PlaceReportOutcome {
  if (report.op === 'absent') {
    const had = sql.exec('SELECT 1 FROM place_member WHERE sub = ? AND app_scope_id = ?', report.sub, appScopeId).toArray().length;
    sql.exec('DELETE FROM place_member WHERE sub = ? AND app_scope_id = ?', report.sub, appScopeId);
    return { added: 0, removed: had, dropped: 0 };
  }
  if (report.op === 'present') {
    if (!hasIssuedTo(sql, clientId, report.sub)) return { added: 0, removed: 0, dropped: 1 };
    const had = sql.exec('SELECT 1 FROM place_member WHERE sub = ? AND app_scope_id = ?', report.sub, appScopeId).toArray().length;
    sql.exec('INSERT OR IGNORE INTO place_member (sub, app_scope_id) VALUES (?, ?)', report.sub, appScopeId);
    return { added: had ? 0 : 1, removed: 0, dropped: 0 };
  }
  const issued = subjectsIssuedTo(sql, clientId);
  const named = new Set(report.subs);
  const keep = new Set([...named].filter((s) => issued.has(s)));
  const existing = (
    sql.exec('SELECT sub FROM place_member WHERE app_scope_id = ?', appScopeId).toArray() as { sub: string }[]
  ).map((r) => r.sub);
  let removed = 0;
  for (const sub of existing) {
    if (keep.has(sub)) continue;
    sql.exec('DELETE FROM place_member WHERE sub = ? AND app_scope_id = ?', sub, appScopeId);
    removed += 1;
  }
  const had = new Set(existing);
  let added = 0;
  for (const sub of keep) {
    if (had.has(sub)) continue;
    sql.exec('INSERT INTO place_member (sub, app_scope_id) VALUES (?, ?)', sub, appScopeId);
    added += 1;
  }
  return { added, removed, dropped: named.size - keep.size };
}

/** How a client authenticates at the token endpoint, read off its own registry row. */
export function authMethodOf(sql: SqlExec, clientId: string): string | undefined {
  const row = (
    sql.exec('SELECT token_endpoint_auth_method FROM oauth_client WHERE client_id = ?', clientId).toArray() as {
      token_endpoint_auth_method: string | null;
    }[]
  )[0];
  return row ? (row.token_endpoint_auth_method ?? 'client_secret_basic') : undefined;
}
