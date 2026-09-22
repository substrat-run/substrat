import { scopeId as scopeIdSchema } from '@substrat-run/contracts';
import type { SqlExec } from './introspect.js';

/**
 * The PLATFORM's half of this issuer's resource registry (#1619) — which MCP endpoints it
 * will mint tokens for, because the platform bound those verticals to it.
 *
 * `@better-auth/oauth-provider` refuses any RFC 8707 `resource` it has no `oauth_resource`
 * row for (`invalid_target … is not configured`). Every vertical mounts an MCP endpoint and
 * advertises this issuer for it, so without a row the endpoint the platform mounted was one
 * the platform's own issuer would not mint for, and a client was turned away before a login
 * page rendered.
 *
 * ## Where the rows come from
 *
 * The dashboard, which is the one place that knows both halves: which hostnames a vertical
 * answers on, and which of the team's issuers it was bound to. It delivers one entry per
 * vertical to this issuer through the ordinary platform-gated `/internal/configure`:
 *
 *     substrat:resources:<the vertical's scope id>  =  ["https://desk.example/api/mcp", …]
 *
 * The value is the WHOLE set for that vertical, not a delta. So re-sending it is a no-op,
 * a hostname that went away drops out, and `""` or `[]` is the un-registration (a delete,
 * or an Identity change away from this issuer). No unauthenticated request can create a
 * row: `/internal/configure` answers only the platform secret.
 *
 * ## What a row owned here looks like
 *
 * An ordinary `oauth_resource` row with every policy column at its default, so the
 * plugin's own defaults decide lifetimes, scopes and signing. Its `metadata` names the
 * vertical that asked for it (`{"substrat":{"app":"<scope id>"}}`). That marker is the whole
 * of ownership:
 *
 *   - A row with NO marker is an operator's, made through the plugin's admin endpoints. It
 *     is never claimed, changed or deleted from here, even when a vertical asks for the same
 *     identifier (the identifier is registered either way, which is all the vertical needs).
 *   - A row marked for ANOTHER vertical is taken over. A hostname serves one scope at a
 *     time, so an older claim on it is stale: that vertical was deleted before it could say
 *     so, or the name was released and reused.
 *   - A row this vertical already owns is left exactly as it is, so an operator who disabled
 *     it keeps it disabled, and a repeat delivery writes nothing at all.
 */

/** The delivered-config key prefix; the rest of the key is the vertical's scope id. */
export const RESOURCES_KEY_PREFIX = 'substrat:resources:';

/** More than any vertical has hostnames for; a bound on what one delivery may write. */
const MAX_RESOURCES_PER_APP = 32;

/** One vertical's desired set, parsed and validated. */
export interface ResourcesDelivery {
  appScopeId: string;
  identifiers: string[];
}

/** What one sync did, for a caller that reports it and a test that pins it. */
export interface ResourcesSync {
  added: string[];
  removed: string[];
  /** Asked for, and left alone because an operator owns the row. */
  operatorOwned: string[];
}

export function isResourcesEntry(key: string): boolean {
  return key.startsWith(RESOURCES_KEY_PREFIX);
}

/**
 * A delivered entry, validated. Throws on anything malformed. The caller parses every entry
 * of a delivery before writing any of them, so a bad one refuses the whole call (400)
 * rather than leaving half of it applied.
 *
 * An identifier must be an absolute `https:` or `http:` URL with no fragment and no
 * credentials. RFC 8707 §2 asks for an absolute URI without a fragment. The scheme is
 * narrowed because every endpoint this registers is a vertical's own URL, and `http:`
 * stays allowed for a local issuer.
 */
export function parseResourcesEntry(key: string, value: string): ResourcesDelivery {
  const appScopeId = scopeIdSchema.parse(key.slice(RESOURCES_KEY_PREFIX.length));
  if (value.trim() === '') return { appScopeId, identifiers: [] };
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((v): v is string => typeof v === 'string')) {
    throw new Error(`${key} must be a JSON array of resource URLs`);
  }
  if (parsed.length > MAX_RESOURCES_PER_APP) {
    throw new Error(`${key} names ${parsed.length} resources; at most ${MAX_RESOURCES_PER_APP} are accepted`);
  }
  for (const identifier of parsed) {
    let url: URL;
    try {
      url = new URL(identifier);
    } catch {
      throw new Error(`${key}: ${identifier} is not an absolute URL`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`${key}: ${identifier} is not http(s)`);
    if (url.hash || identifier.includes('#')) throw new Error(`${key}: ${identifier} carries a fragment (RFC 8707 §2)`);
    if (url.username || url.password) throw new Error(`${key}: ${identifier} carries credentials`);
  }
  return { appScopeId, identifiers: [...new Set(parsed)] };
}

/** Which vertical a row's `metadata` says asked for it, or null for an operator's row. */
function ownerOf(metadata: unknown): string | null {
  if (typeof metadata !== 'string') return null;
  try {
    const app = (JSON.parse(metadata) as { substrat?: { app?: unknown } } | null)?.substrat?.app;
    return typeof app === 'string' ? app : null;
  } catch {
    return null;
  }
}

/**
 * Make the platform-owned rows for `appScopeId` exactly `identifiers` (see the header for
 * what "owned" means and how the three cases are treated).
 *
 * Synchronous from first read to last write, with no `await` between them. In a Durable
 * Object that makes the whole sync one implicit transaction: writes with no intervening
 * `await` commit together, and no other request interleaves.
 */
export function syncPlatformResources(
  sql: SqlExec,
  delivery: ResourcesDelivery,
  nowMs: number,
): ResourcesSync {
  const { appScopeId, identifiers } = delivery;
  const rows = sql.exec('SELECT identifier, metadata FROM oauth_resource').toArray() as {
    identifier: string;
    metadata: unknown;
  }[];
  const byIdentifier = new Map(rows.map((r) => [r.identifier, ownerOf(r.metadata)]));
  const wanted = new Set(identifiers);
  const marker = JSON.stringify({ substrat: { app: appScopeId } });
  const result: ResourcesSync = { added: [], removed: [], operatorOwned: [] };

  for (const [identifier, owner] of byIdentifier) {
    if (owner !== appScopeId || wanted.has(identifier)) continue;
    // Links first: nothing links a platform resource today (per-client enforcement is off),
    // but the foreign key is ON DELETE CASCADE only where the runtime enforces foreign keys,
    // and a link to a missing resource must not outlive it anywhere.
    sql.exec('DELETE FROM oauth_client_resource WHERE resource_id = ?', identifier);
    sql.exec('DELETE FROM oauth_resource WHERE identifier = ?', identifier);
    result.removed.push(identifier);
  }

  for (const identifier of identifiers) {
    if (!byIdentifier.has(identifier)) {
      sql.exec(
        `INSERT INTO oauth_resource (id, identifier, name, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        crypto.randomUUID(),
        identifier,
        identifier,
        marker,
        nowMs,
        nowMs,
      );
      result.added.push(identifier);
      continue;
    }
    const owner = byIdentifier.get(identifier);
    if (owner === appScopeId) continue;
    if (owner === null) {
      result.operatorOwned.push(identifier);
      continue;
    }
    // Another vertical's stale claim on a hostname that now serves this one.
    sql.exec('UPDATE oauth_resource SET metadata = ?, updated_at = ? WHERE identifier = ?', marker, nowMs, identifier);
    result.added.push(identifier);
  }
  return result;
}
