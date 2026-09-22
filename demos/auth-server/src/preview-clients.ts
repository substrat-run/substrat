import type {
  MintedPreviewClient,
  PreviewClientCheck,
  PreviewClientMint,
  PreviewClientRetire,
  RetiredPreviewClients,
} from '@substrat-run/contracts';
import type { SqlExec } from './introspect.js';
import { platformOwnerOf } from './resources.js';

/**
 * A PREVIEW's own clients at this issuer (#1704) — the issuer's half of the protocol whose
 * vocabulary and reasoning live in `@substrat-run/contracts` (`preview-client.ts`).
 *
 * A preview of an app that signs in here cannot use the app's client: the fork's config
 * store starts empty, and the platform never reads back or copies the app's secret. So the
 * platform asks THIS issuer to mint the preview a client of its own, and to delete it when
 * the preview is reaped. Three verbs, each platform-gated and addressed by this issuer's own
 * scope (the route and the DO refuse any other tenant's call before reaching here):
 *
 *   - **check** — does the parent app sign in here? Read-only.
 *   - **mint** — register the preview's client through the SAME dynamic registration an
 *     install uses, then record it in `preview_client` with this issuer's generation.
 *   - **retire** — delete clients recorded for a preview, and only those.
 *
 * ## Why the check is not a redirect-URI match
 *
 * Open DCR means anybody can register a client whose callback is the parent's, so a match
 * alone would let a stranger decide which issuer a preview is wired to. The check therefore
 * requires a binding for the parent scope that only the PLATFORM writes here — a
 * `place_app` row for it in the calling tenant (#1670), or an `oauth_resource` row whose
 * marker names it (#1619) — and, beside it, an enabled client that redirects to one of the
 * parent's callbacks. Neither half is something a DCR caller can produce.
 *
 * ## Why a delete cannot reach prod's client
 *
 * Every delete reads its targets from `preview_client`, filtered by the preview's scope, and
 * nowhere else. A client not minted by `mintPreviewClient` has no row there, so no argument
 * to any verb can select it.
 */

/** What an issuer-side refusal looks like, before the route turns it into a status. */
export class PreviewClientRefusal extends Error {
  constructor(
    readonly status: 400 | 403 | 409,
    message: string,
  ) {
    super(message);
  }
}

/** The dynamic registration an install performs, in-process — the plugin's own `/oauth2/register`. */
export type RegisterClientFn = (body: Record<string, unknown>) => Promise<{ client_id: string; client_secret: string }>;

/** Does a platform-written binding name the parent scope? See the header for why this is required. */
function platformBinds(sql: SqlExec, tenantId: string, parentScopeId: string): boolean {
  const place = sql
    .exec('SELECT 1 AS hit FROM place_app WHERE app_scope_id = ? AND tenant_id = ? LIMIT 1', parentScopeId, tenantId)
    .toArray();
  if (place.length > 0) return true;
  const resources = sql.exec('SELECT metadata FROM oauth_resource').toArray() as { metadata: unknown }[];
  return resources.some((r) => platformOwnerOf(r.metadata) === parentScopeId);
}

/**
 * Is there an ENABLED client whose redirect URIs contain one of the parent's callbacks? A
 * registry can hold many self-registered clients, so this asks SQLite rather than reading
 * every row back; a row whose column is not valid JSON is read as having none.
 */
function clientRedirectsTo(sql: SqlExec, uris: readonly string[]): boolean {
  const placeholders = uris.map(() => '?').join(', ');
  const rows = sql
    .exec(
      `SELECT 1 AS hit
         FROM oauth_client c,
              json_each(CASE WHEN json_valid(c.redirect_uris) THEN c.redirect_uris ELSE '[]' END) u
        WHERE COALESCE(c.disabled, 0) = 0 AND u.value IN (${placeholders})
        LIMIT 1`,
      ...uris,
    )
    .toArray();
  return rows.length > 0;
}

/** The check: this issuer holds the platform's binding for the parent, AND a live client for it. */
export function claimsParent(sql: SqlExec, input: PreviewClientCheck): boolean {
  return platformBinds(sql, input.tenantId, input.parentScopeId) && clientRedirectsTo(sql, input.parentRedirectUris);
}

/**
 * Remove one client and what it holds — the same order the admin console's delete uses
 * (`admin-api.ts`): the tables that reference `oauth_client` without a cascade first, or the
 * foreign key refuses; and a token outliving its client would keep authenticating. The
 * `preview_client` row goes explicitly too, because a runtime that does not enforce foreign
 * keys would otherwise leave it behind.
 */
function deleteClient(sql: SqlExec, clientId: string): void {
  for (const table of ['oauth_access_token', 'oauth_refresh_token', 'oauth_consent', 'oauth_client_resource']) {
    sql.exec(`DELETE FROM "${table}" WHERE client_id = ?`, clientId);
  }
  sql.exec('DELETE FROM preview_client WHERE client_id = ?', clientId);
  sql.exec('DELETE FROM oauth_client WHERE client_id = ?', clientId);
}

/**
 * Mint a preview's client. Re-checks the parent first — a mint is never cheaper to reach than
 * a check. The registration carries EXACTLY the preview's two URIs, through the plugin's own
 * dynamic registration (which mints the id, hashes the secret and validates the URIs), and
 * its secret is returned to the caller ONCE: nothing here can return it again.
 *
 * `transaction` wraps the synchronous record-keeping after the registration's await, so the
 * row and its generation land together or, on a throw, the client just registered is removed
 * rather than left behind untagged — an untagged client is one no platform verb can delete.
 */
export async function mintPreviewClient(
  sql: SqlExec,
  register: RegisterClientFn,
  input: PreviewClientMint,
  transaction: <T>(fn: () => T) => T,
): Promise<MintedPreviewClient> {
  if (!claimsParent(sql, input)) {
    throw new PreviewClientRefusal(409, `this issuer does not sign in scope ${input.parentScopeId} — no preview client minted`);
  }
  const parents = new Set(input.parentRedirectUris);
  if (parents.has(input.redirectUri) || parents.has(input.postLogoutRedirectUri)) {
    throw new PreviewClientRefusal(400, "a preview client's redirect URIs must be the preview's own, never the parent's");
  }
  const registered = await register({
    client_name: input.clientName,
    redirect_uris: [input.redirectUri],
    post_logout_redirect_uris: [input.postLogoutRedirectUri],
    // How the relying party presents the secret (oidc-rp sends it in the token-request body),
    // exactly as the dashboard's install-time registration asks for it.
    token_endpoint_auth_method: 'client_secret_post',
  });
  try {
    const generation = transaction(() => {
      sql.exec(
        'INSERT INTO preview_client (client_id, preview_scope_id) VALUES (?, ?)',
        registered.client_id,
        input.previewScopeId,
      );
      const row = sql
        .exec('SELECT generation FROM preview_client WHERE client_id = ?', registered.client_id)
        .toArray()[0] as { generation: number } | undefined;
      if (!row) throw new Error('preview client row did not land');
      return Number(row.generation);
    });
    return { clientId: registered.client_id, clientSecret: registered.client_secret, generation };
  } catch (e) {
    transaction(() => deleteClient(sql, registered.client_id));
    throw e;
  }
}

/**
 * Delete a preview's clients (see `previewClientRetire` for the three shapes). Reads its
 * targets from `preview_client` alone. Synchronous from first read to last write, so no
 * other request interleaves; the caller supplies the transaction.
 */
export function retirePreviewClients(sql: SqlExec, input: PreviewClientRetire): RetiredPreviewClients {
  const rows = sql
    .exec(
      'SELECT generation, client_id FROM preview_client WHERE preview_scope_id = ? ORDER BY generation',
      input.previewScopeId,
    )
    .toArray()
    .map((r) => ({ generation: Number(r.generation), clientId: String(r.client_id) }));
  let targets: typeof rows;
  let kept: boolean | null = null;
  let superseded = false;
  if (input.only) {
    targets = rows.filter((r) => r.clientId === input.only);
  } else if (input.keep) {
    const keptRow = rows.find((r) => r.clientId === input.keep);
    kept = keptRow !== undefined;
    // With the kept client gone there is no generation to judge "older" by, so nothing is
    // deleted: the caller learns `kept: false` and decides again.
    targets = keptRow ? rows.filter((r) => r.generation < keptRow.generation) : [];
    superseded = keptRow ? rows.some((r) => r.generation > keptRow.generation) : false;
  } else {
    targets = rows;
  }
  for (const t of targets) deleteClient(sql, t.clientId);
  return { deleted: targets.map((t) => t.clientId), kept, superseded };
}
