/**
 * The control plane's half of the routing read model (#3395): it captures every directory change
 * that moves a route or a vertical's serving policy, and publishes the result to Workers KV.
 *
 * **Capture is a mechanism, not a list of call sites.** SQLite triggers on the five tables the
 * route read joins (`hostnames`, `scopes`, `tenants`, `verticals`, `vertical_versions`) append the
 * affected keys to an outbox in the same transaction as the change: a hostname bound, activated or
 * removed, a scope bound, re-pointed, forked, suspended or reaped, a tenant's status, a promote.
 * A write path added later is captured without anyone remembering to.
 *
 * The triggers do nothing but append. They read no JSON and meet no constraint (the outbox's key
 * is its rowid), because a trigger that can fail is a directory write that can fail. An outer
 * statement's `OR IGNORE` would also override an inner conflict clause (SQLite), so an upserting
 * outbox could silently drop a re-dirty; an append cannot.
 *
 * **Publishing** recomputes each dirty key from the directory, compares a digest with the last one
 * published, and writes or deletes the KV entry only on a change. A key leaves the outbox only up
 * to the row it was read at, so a change made while its publish was in flight is published again.
 *
 * **Residency (K-36).** A route whose hostname region or scope jurisdiction is pinned (`eu`, `us`)
 * is never written: KV has no jurisdiction. The router reads such a route from the directory.
 *
 * The ledger of what was published (`route_read_model_published`) describes KV, not the
 * directory, so a directory dump does not carry it and a restore does not drop it — the way the
 * lifecycle epoch is the store's and not the data's. A restore then marks every key dirty, which
 * re-publishes the restored directory AND deletes every route it no longer holds.
 */
import { ROUTE_SCOPE_HOSTNAMES_MAX } from '@substrat-run/contracts';
import { isPrimaryScopeRow } from '@substrat-run/kernel';
import {
  peerCallKeyPart,
  ROUTE_READ_MODEL_VERSION,
  routeKvKey,
  servingPolicyKvKey,
  type PeerCallEntry,
  type PeerCallKey,
  type RefusedRouteEntry,
  type RouteEntry,
  type ServingPolicyEntry,
} from './route-read-model.js';
import { readPeerCallTarget, type PeerCallTargetRow, type PeerCallTargetSource } from './peer-call-target.js';

type Entry = RouteEntry | RefusedRouteEntry | ServingPolicyEntry | PeerCallEntry;

/** The tables this owns. Excluded from a directory dump, and from a restore's drop. */
export const ROUTE_READ_MODEL_TABLE_GLOB = 'route_read_model_*';

/** The slice of a KV binding the publisher writes through (and reads its ledger marker from). */
export interface RouteKvWriter {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** A binding that looks like KV, or nothing: the read model is on only where one is bound. */
export function routeKvWriterOf(value: unknown): RouteKvWriter | null {
  if (typeof value !== 'object' || value === null) return null;
  const ok = ['get', 'put', 'delete'].every((m) => typeof Reflect.get(value, m) === 'function');
  return ok ? (value as RouteKvWriter) : null;
}

/**
 * The KV key naming which ledger the namespace's entries were confirmed by. The ledger keeps the
 * same id; a namespace whose marker differs (or is missing) is not the one the ledger describes —
 * the `ROUTES` binding was pointed at another namespace — so the ledger is cleared and every key
 * republished. The router never reads it (it is no route entry).
 */
export const ROUTE_LEDGER_MARKER_KEY = 'route/v1/meta/ledger';
const LEDGER_SOURCE = 'ledger-namespace';

const TABLES_DDL = [
  // Append-only: `id` is the rowid, so no insert here can meet a constraint.
  `CREATE TABLE IF NOT EXISTS route_read_model_outbox (id INTEGER PRIMARY KEY, key TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS route_read_model_outbox_key ON route_read_model_outbox (key, id)`,
  `CREATE TABLE IF NOT EXISTS route_read_model_published (key TEXT PRIMARY KEY, digest TEXT NOT NULL, at TEXT NOT NULL)`,
  // The reconcile pass's position in each source, so a pass resumes where the last one stopped.
  `CREATE TABLE IF NOT EXISTS route_read_model_cursor (source TEXT PRIMARY KEY, after TEXT NOT NULL)`,
  // The version trigger re-reads the legacy scopes bound to a version; without this, a scan.
  `CREATE INDEX IF NOT EXISTS scopes_vertical_version ON scopes (vertical_version_id)`,
];

const append = (select: string) => `INSERT INTO route_read_model_outbox (key) ${select};`;
const hostnamesOfScope = (scope: string) => append(`SELECT 'h:' || hostname FROM hostnames WHERE scope_id = ${scope}`);
const hostnamesOfTenant = (tenant: string) =>
  append(
    `SELECT 'h:' || h.hostname FROM scopes s JOIN hostnames h ON h.scope_id = s.scope_id WHERE s.tenant_id = ${tenant}`,
  );
/** A version moves the verticals it serves, and the legacy scopes that run it on its own script. */
const dependentsOfVersion = (row: 'NEW' | 'OLD') =>
  append(`SELECT 'v:' || slug FROM verticals WHERE serving_version_id = ${row}.id`) +
  append(
    `SELECT 'h:' || h.hostname FROM scopes s JOIN hostnames h ON h.scope_id = s.scope_id
      WHERE s.vertical_version_id = ${row}.id AND s.serving_ref IS NULL`,
  );

/**
 * Every column the route read uses is in an `UPDATE OF` list, and no other: a scope's row is
 * updated for its migration bookkeeping far more often than it is re-routed.
 */
const TRIGGERS: Array<[name: string, ddl: string]> = [
  // `INSERT OR REPLACE` deletes the old row without firing a DELETE trigger (recursive triggers
  // are off), so a hostname re-bound to another scope would leave its old scope's siblings listing
  // it. BEFORE the insert, the old row is still there to name that scope.
  [
    'rrm_hostnames_bi',
    `BEFORE INSERT ON hostnames BEGIN
       ${append(`SELECT 'h:' || h.hostname FROM hostnames o JOIN hostnames h ON h.scope_id = o.scope_id WHERE o.hostname = NEW.hostname`)} END`,
  ],
  ['rrm_hostnames_ai', `AFTER INSERT ON hostnames BEGIN ${append(`SELECT 'h:' || NEW.hostname`)} ${hostnamesOfScope('NEW.scope_id')} END`],
  [
    'rrm_hostnames_au',
    `AFTER UPDATE OF hostname, tenant_id, scope_id, vertical_slug, surface, region, status ON hostnames BEGIN
       ${append(`SELECT 'h:' || OLD.hostname`)} ${append(`SELECT 'h:' || NEW.hostname`)}
       ${hostnamesOfScope('OLD.scope_id')} ${hostnamesOfScope('NEW.scope_id')} END`,
  ],
  ['rrm_hostnames_ad', `AFTER DELETE ON hostnames BEGIN ${append(`SELECT 'h:' || OLD.hostname`)} ${hostnamesOfScope('OLD.scope_id')} END`],
  ['rrm_scopes_ai', `AFTER INSERT ON scopes BEGIN ${hostnamesOfScope('NEW.scope_id')} END`],
  [
    'rrm_scopes_au',
    `AFTER UPDATE OF tenant_id, status, serving_ref, vertical_version_id, vertical, kind, forked_from, jurisdiction ON scopes
     BEGIN ${hostnamesOfScope('NEW.scope_id')} END`,
  ],
  ['rrm_scopes_ad', `AFTER DELETE ON scopes BEGIN ${hostnamesOfScope('OLD.scope_id')} END`],
  // An insert too: a tenant row replaced whole (a restore, an `INSERT OR REPLACE`) is no UPDATE.
  ['rrm_tenants_ai', `AFTER INSERT ON tenants BEGIN ${hostnamesOfTenant('NEW.tenant_id')} END`],
  ['rrm_tenants_au', `AFTER UPDATE OF status ON tenants BEGIN ${hostnamesOfTenant('NEW.tenant_id')} END`],
  ['rrm_tenants_ad', `AFTER DELETE ON tenants BEGIN ${hostnamesOfTenant('OLD.tenant_id')} END`],
  ['rrm_verticals_ai', `AFTER INSERT ON verticals BEGIN ${append(`SELECT 'v:' || NEW.slug`)} END`],
  [
    'rrm_verticals_au',
    `AFTER UPDATE OF slug, serving_ref, serving_version_id ON verticals BEGIN
       ${append(`SELECT 'v:' || OLD.slug`)} ${append(`SELECT 'v:' || NEW.slug`)} END`,
  ],
  ['rrm_verticals_ad', `AFTER DELETE ON verticals BEGIN ${append(`SELECT 'v:' || OLD.slug`)} END`],
  ['rrm_versions_ai', `AFTER INSERT ON vertical_versions BEGIN ${dependentsOfVersion('NEW')} END`],
  ['rrm_versions_au', `AFTER UPDATE OF id, deployment_ref, manifest_json ON vertical_versions BEGIN ${dependentsOfVersion('OLD')} ${dependentsOfVersion('NEW')} END`],
  ['rrm_versions_ad', `AFTER DELETE ON vertical_versions BEGIN ${dependentsOfVersion('OLD')} END`],
];

/**
 * Peer-call answers (`c:<tenant>/…`, #3395 follow-up) are published only once a router asked for
 * one, so their capture re-dirties only the answers of the changed tenant that are published or
 * queued: a range of keys, since the tenant leads the key. With no peer answer requested (every
 * router's `PEER_READ_MODEL` off) these find nothing and append nothing. A queued key counts as well
 * as a published one, because a flush computes a key, awaits, and only then records it in the
 * ledger: a change landing in between still finds the key's outbox row and queues it again.
 *
 * A peer call is answered inside one tenant (the caller's), so every input of the answer is a row
 * of that tenant: its scopes (the caller and every candidate), the tenant itself (status, and the
 * slug the pinned spellings read), its peer bindings, and its scopes' hostnames (residency). The
 * one input outside a tenant row is a legacy target's own version; its trigger finds the tenants
 * bound to it. A promote moves the serving policy (`v:`), which no peer entry holds.
 */
const peersOfTenantsIn = (tenants: string) => {
  const range = (t: string, k: string) => `${k}.key >= 'c:' || ${t}.tenant_id || '/' AND ${k}.key < 'c:' || ${t}.tenant_id || '0'`;
  return append(
    `SELECT p.key FROM (${tenants}) t JOIN route_read_model_published p ON ${range('t', 'p')}
     UNION SELECT o.key FROM (${tenants}) t JOIN route_read_model_outbox o ON ${range('t', 'o')}`,
  );
};
const peersOfTenant = (tenant: string) => peersOfTenantsIn(`SELECT ${tenant} AS tenant_id`);
const peersOfVersion = (row: 'NEW' | 'OLD') =>
  peersOfTenantsIn(`SELECT DISTINCT tenant_id FROM scopes WHERE vertical_version_id = ${row}.id AND serving_ref IS NULL`);

/** New names, never an edit of a route trigger: `install` creates a trigger only when its name is missing. */
const PEER_TRIGGERS: Array<[name: string, ddl: string]> = [
  ['rrm_peer_scopes_ai', `AFTER INSERT ON scopes BEGIN ${peersOfTenant('NEW.tenant_id')} END`],
  [
    'rrm_peer_scopes_au',
    `AFTER UPDATE OF tenant_id, status, serving_ref, vertical_version_id, vertical, kind, forked_from, jurisdiction ON scopes
     BEGIN ${peersOfTenant('OLD.tenant_id')} ${peersOfTenant('NEW.tenant_id')} END`,
  ],
  ['rrm_peer_scopes_ad', `AFTER DELETE ON scopes BEGIN ${peersOfTenant('OLD.tenant_id')} END`],
  ['rrm_peer_tenants_ai', `AFTER INSERT ON tenants BEGIN ${peersOfTenant('NEW.tenant_id')} END`],
  ['rrm_peer_tenants_au', `AFTER UPDATE OF status, slug ON tenants BEGIN ${peersOfTenant('NEW.tenant_id')} END`],
  ['rrm_peer_tenants_ad', `AFTER DELETE ON tenants BEGIN ${peersOfTenant('OLD.tenant_id')} END`],
  ['rrm_peer_bindings_ai', `AFTER INSERT ON peer_bindings BEGIN ${peersOfTenant('NEW.tenant_id')} END`],
  ['rrm_peer_bindings_au', `AFTER UPDATE ON peer_bindings BEGIN ${peersOfTenant('OLD.tenant_id')} ${peersOfTenant('NEW.tenant_id')} END`],
  ['rrm_peer_bindings_ad', `AFTER DELETE ON peer_bindings BEGIN ${peersOfTenant('OLD.tenant_id')} END`],
  ['rrm_peer_hostnames_ai', `AFTER INSERT ON hostnames BEGIN ${peersOfTenant('NEW.tenant_id')} END`],
  [
    'rrm_peer_hostnames_au',
    `AFTER UPDATE OF tenant_id, scope_id, region, status ON hostnames
     BEGIN ${peersOfTenant('OLD.tenant_id')} ${peersOfTenant('NEW.tenant_id')} END`,
  ],
  ['rrm_peer_hostnames_ad', `AFTER DELETE ON hostnames BEGIN ${peersOfTenant('OLD.tenant_id')} END`],
  ['rrm_peer_versions_ai', `AFTER INSERT ON vertical_versions BEGIN ${peersOfVersion('NEW')} END`],
  ['rrm_peer_versions_au', `AFTER UPDATE OF id, deployment_ref, manifest_json ON vertical_versions BEGIN ${peersOfVersion('OLD')} ${peersOfVersion('NEW')} END`],
  ['rrm_peer_versions_ad', `AFTER DELETE ON vertical_versions BEGIN ${peersOfVersion('OLD')} END`],
];

/** Every published or queued peer-call key: `c:` up to the next character, `;`. */
const ALL_PEER_KEYS = `key >= 'c:' AND key < 'c;'`;

export const ROUTE_READ_MODEL_TRIGGERS = [...TRIGGERS, ...PEER_TRIGGERS].map(([name]) => name);

/** The route read, as the read model stores it: the same joins and gates as `READ_ROUTE_SQL`. */
const ROUTE_ENTRY_SQL = `SELECT h.tenant_id, h.scope_id, h.vertical_slug, h.surface, h.region, s.jurisdiction,
       s.serving_ref, s.vertical, s.kind, s.forked_from,
       vv.id AS version_id, vv.deployment_ref AS version_ref,
       json_extract(vv.manifest_json, '$.outbound') AS outbound_json,
       json_extract(vv.manifest_json, '$.calls') AS calls_json,
       json_extract(vv.manifest_json, '$.scopeStores') AS scope_stores_json,
       EXISTS (SELECT 1 FROM hostnames INDEXED BY hostnames_scope
                WHERE scope_id = s.scope_id AND status = 'active' AND region IS NOT NULL) AS scope_has_pinned,
       (SELECT json_group_array(sh.hostname) FROM (
          SELECT hostname FROM hostnames INDEXED BY hostnames_scope
           WHERE scope_id = s.scope_id AND status = 'active'
           ORDER BY hostname LIMIT ${ROUTE_SCOPE_HOSTNAMES_MAX}
        ) sh) AS scope_hostnames_json
  FROM hostnames h
  JOIN scopes s ON s.scope_id = h.scope_id AND s.tenant_id = h.tenant_id
  JOIN tenants t ON t.tenant_id = s.tenant_id
  LEFT JOIN vertical_versions vv ON vv.id = s.vertical_version_id
 WHERE h.hostname = ? AND h.status = 'active' AND s.status = 'active' AND t.status = 'active'`;

const SERVING_POLICY_SQL = `SELECT vr.serving_ref,
       json_extract(sv.manifest_json, '$.outbound') AS outbound_json,
       json_extract(sv.manifest_json, '$.calls') AS calls_json,
       json_extract(sv.manifest_json, '$.scopeStores') AS scope_stores_json
  FROM verticals vr LEFT JOIN vertical_versions sv ON sv.id = vr.serving_version_id
 WHERE vr.slug = ?`;

/** A jurisdiction that pins storage, which KV cannot honour (K-36). `global` pins nothing. */
const isPinned = (jurisdiction: string | null): boolean => jurisdiction !== null && jurisdiction !== 'global';

type Sql = SqlStorage;
type Text = string | null;

/** An active hostname that does not route, and whether its route would be pinned. */
const REFUSED_ROUTE_SQL = `SELECT h.region, s.jurisdiction FROM hostnames h
  LEFT JOIN scopes s ON s.scope_id = h.scope_id WHERE h.hostname = ? AND h.status = 'active'`;

// ---------------------------------------------------------------------------
// The projection: what an entry is, and the one writer that puts it in KV.
//
// These three are the read model's whole contract with whatever holds the source data. Today that
// is the one directory (`computeRouteReadModelEntry` below reads its tables). When the directory
// splits into a global registry and per-tenant objects (K-68, directory split; the data-at-scale
// RFC's step 3), each of those builds its entries from its own rows with `routeEntryOf` /
// `servingPolicyEntryOf` and writes them with `writeRouteReadModelEntry`: the entry shapes, the
// residency rule, the digest and the ledger then cannot differ between the sources, and the router
// does not know the source moved.
// ---------------------------------------------------------------------------

/**
 * The read model's own key for an entry: `h:<hostname>` for a route, `v:<slug>` for a policy,
 * `c:<tenant>/<caller scope>/<caller vertical>/<target>` for a peer-call answer.
 */
export type RouteReadModelKey = `h:${string}` | `v:${string}` | `c:${string}`;
export const peerCallEntryKey = (k: PeerCallKey): RouteReadModelKey => `c:${peerCallKeyPart(k)}`;

/** A `c:` key back into what it is keyed by; undefined for one this code did not write. */
function peerCallKeyOf(key: string): PeerCallKey | undefined {
  const parts = key.slice(2).split('/');
  if (parts.length !== 4 || parts.some((p) => p === '')) return undefined;
  try {
    return {
      tenantId: parts[0]!,
      callerScopeId: parts[1]!,
      callerVertical: decodeURIComponent(parts[2]!),
      vertical: decodeURIComponent(parts[3]!),
    };
  } catch {
    return undefined;
  }
}
export const routeEntryKey = (hostname: string): RouteReadModelKey => `h:${hostname}`;
export const servingPolicyEntryKey = (slug: string): RouteReadModelKey => `v:${slug}`;

/** What the source knows about one hostname: its row, its scope's and whether the route serves. */
export interface RouteSourceFields {
  /** The hostname is active AND its scope and its tenant are active, correctly paired (#1713). */
  routes: boolean;
  /** The hostname itself is active (a refusal is published only for an active name). */
  hostnameActive: boolean;
  tenant_id: string;
  scope_id: string;
  vertical_slug: string | null;
  surface: string;
  region: string | null;
  jurisdiction: string | null;
  serving_ref: string | null;
  /** The scope's vertical: whose serving policy a `serving` dispatch takes. */
  vertical: string | null;
  kind: string | null;
  forked_from: string | null;
  /** The scope's bound version, when it exists: its id, script and policy as manifest JSON text. */
  version: ({ id: string; deployment_ref: string | null } & PolicyFields) | null;
  /** The scope's active hostnames, sorted, at most `ROUTE_SCOPE_HOSTNAMES_MAX`. */
  scope_hostnames: string[];
  /** Any active hostname of the scope is region-pinned: its NAME would be in this route's value. */
  scopeHasPinnedHostname: boolean;
}

type PolicyFields = Pick<ServingPolicyEntry, 'outbound_json' | 'calls_json' | 'scope_stores_json'>;

/**
 * A hostname's entry, from its source fields: a route, a refusal, or null for no entry. Null for
 * any residency-pinned name (K-36): KV has no jurisdiction, so the router asks the source. Null too
 * for a route whose scope also holds a pinned hostname, because the route's value lists the scope's
 * hostnames, and no pinned name may appear in any KV value.
 */
export function routeEntryOf(f: RouteSourceFields): RouteEntry | RefusedRouteEntry | null {
  if (f.region !== null || isPinned(f.jurisdiction)) return null;
  if (f.routes && f.scopeHasPinnedHostname) return null;
  if (!f.routes) return f.hostnameActive ? { v: ROUTE_READ_MODEL_VERSION, refused: true } : null;
  const dispatch: RouteEntry['dispatch'] = f.serving_ref !== null
    ? { kind: 'serving', ref: f.serving_ref, vertical: f.vertical }
    : f.version
      ? {
          kind: 'version',
          ref: f.version.deployment_ref,
          outbound_json: f.version.outbound_json,
          calls_json: f.version.calls_json,
          scope_stores_json: f.version.scope_stores_json,
        }
      : { kind: 'none' };
  return {
    v: ROUTE_READ_MODEL_VERSION,
    tenant_id: f.tenant_id,
    scope_id: f.scope_id,
    vertical_slug: f.vertical_slug,
    surface: f.surface,
    region: null,
    primary: isPrimaryScopeRow({ kind: f.kind, forked_from: f.forked_from }),
    scope_hostnames: f.scope_hostnames,
    dispatch,
  };
}

/** A vertical's serving policy, from its row and its serving version's manifest fields. */
export function servingPolicyEntryOf(f: { serving_ref: string | null } & PolicyFields): ServingPolicyEntry {
  return {
    v: ROUTE_READ_MODEL_VERSION,
    serving_ref: f.serving_ref,
    outbound_json: f.outbound_json,
    calls_json: f.calls_json,
    scope_stores_json: f.scope_stores_json,
  };
}

/**
 * A peer-call answer's entry, from the directory's own answer (`readPeerCallTarget`): published only
 * when the router would DISPATCH it, and never when either scope is residency-pinned (K-36). Null
 * otherwise, so every refusal and every pinned call is answered by the source.
 */
export function peerCallEntryOf(
  key: PeerCallKey,
  read: { row: PeerCallTargetRow; source: PeerCallTargetSource },
): PeerCallEntry | null {
  const { row, source } = read;
  const t = row.target;
  if (source.pinned || row.caller.state !== 'ok' || row.outcome !== 'resolved') return null;
  if (!t || !source.target || t.vertical === null || !t.deployment_ref) return null;
  // The router refuses a self-call (#2252), so it is no dispatch to publish.
  if (t.scope_id === key.callerScopeId) return null;
  const dispatch: PeerCallEntry['target']['dispatch'] = source.target.serving_ref !== null
    ? { kind: 'serving', ref: source.target.serving_ref }
    : { kind: 'version', ref: t.deployment_ref, outbound_json: t.outbound_json, calls_json: t.calls_json };
  return {
    v: ROUTE_READ_MODEL_VERSION,
    peer: true,
    caller_tenant_slug: row.caller.tenantSlug,
    target: { scope_id: t.scope_id, tenant_id: t.tenant_id, vertical: t.vertical, dispatch },
  };
}

/** What has been published, by key: the digest the writer compares against. Kept by the source. */
export interface PublishedLedger {
  digest(key: RouteReadModelKey): string | undefined;
  set(key: RouteReadModelKey, digest: string): void;
  delete(key: RouteReadModelKey): void;
}

/** The ledger as a table in the source's own SQLite (`route_read_model_published`). */
export function sqlPublishedLedger(sql: SqlStorage): PublishedLedger {
  return {
    digest: (key) =>
      (sql.exec('SELECT digest FROM route_read_model_published WHERE key = ?', key).toArray()[0] as { digest: string } | undefined)?.digest,
    set: (key, digest) => {
      sql.exec(
        `INSERT INTO route_read_model_published (key, digest, at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET digest = excluded.digest, at = excluded.at`,
        key, digest, new Date().toISOString(),
      );
    },
    delete: (key) => {
      sql.exec('DELETE FROM route_read_model_published WHERE key = ?', key);
    },
  };
}

/**
 * The ledger's mark for a write that was started and not confirmed. It matches no digest, so the
 * key is written again, and it is a ledger entry, so a later "no entry" deletes from KV: an object
 * that stopped between KV accepting a put and the ledger recording it leaves nothing behind.
 */
export const UNCERTAIN_DIGEST = 'uncertain';

/**
 * THE projection writer: put one entry in KV, or delete it, unless the ledger says KV already holds
 * it. The ledger records the write as uncertain before KV is asked and as confirmed only after KV
 * accepted, so neither a refused nor an interrupted write is ever taken for done. Every source
 * writes through this, and nothing else writes the namespace.
 */
export async function writeRouteReadModelEntry(
  to: { kv: RouteKvWriter; ledger: PublishedLedger },
  key: RouteReadModelKey,
  value: Entry | null,
): Promise<'written' | 'deleted' | 'unchanged'> {
  const published = to.ledger.digest(key);
  if (value === null) {
    if (published === undefined) return 'unchanged';
    await to.kv.delete(kvKeyOf(key));
    to.ledger.delete(key);
    return 'deleted';
  }
  const text = JSON.stringify(value);
  const digest = await digestOf(text);
  if (published === digest) return 'unchanged';
  to.ledger.set(key, UNCERTAIN_DIGEST);
  await to.kv.put(kvKeyOf(key), text);
  to.ledger.set(key, digest);
  return 'written';
}

/** The comparison the reconcile makes: would the writer change anything for this entry? */
export async function routeReadModelEntryDiffers(ledger: PublishedLedger, key: RouteReadModelKey, value: Entry | null): Promise<boolean> {
  const digest = value === null ? undefined : await digestOf(JSON.stringify(value));
  return digest !== ledger.digest(key);
}

// ---------------------------------------------------------------------------
// The source as it is today: the one directory's tables.
// ---------------------------------------------------------------------------

/** What a dirty key publishes now, read from the directory: an entry, or null for no entry. */
export function computeRouteReadModelEntry(sql: Sql, key: string): Entry | null {
  if (key.startsWith('h:')) {
    const hostname = key.slice(2);
    const r = sql.exec(ROUTE_ENTRY_SQL, hostname).toArray()[0] as Record<string, unknown> | undefined;
    if (!r) {
      // Not routed: an active name whose scope or tenant is not is a refusal; anything else is none.
      const held = sql.exec(REFUSED_ROUTE_SQL, hostname).toArray()[0] as { region: Text; jurisdiction: Text } | undefined;
      if (!held) return null;
      return routeEntryOf({
        routes: false, hostnameActive: true, region: held.region, jurisdiction: held.jurisdiction,
        tenant_id: '', scope_id: '', vertical_slug: null, surface: '', serving_ref: null, vertical: null,
        kind: null, forked_from: null, version: null, scope_hostnames: [], scopeHasPinnedHostname: false,
      });
    }
    return routeEntryOf({
      routes: true,
      hostnameActive: true,
      tenant_id: r['tenant_id'] as string,
      scope_id: r['scope_id'] as string,
      vertical_slug: r['vertical_slug'] as Text,
      surface: r['surface'] as string,
      region: r['region'] as Text,
      jurisdiction: r['jurisdiction'] as Text,
      serving_ref: r['serving_ref'] as Text,
      vertical: r['vertical'] as Text,
      kind: r['kind'] as Text,
      forked_from: r['forked_from'] as Text,
      version: r['version_id'] !== null
        ? {
            id: r['version_id'] as string,
            deployment_ref: r['version_ref'] as Text,
            outbound_json: r['outbound_json'] as Text,
            calls_json: r['calls_json'] as Text,
            scope_stores_json: r['scope_stores_json'] as Text,
          }
        : null,
      scope_hostnames: JSON.parse(r['scope_hostnames_json'] as string) as string[],
      scopeHasPinnedHostname: Number(r['scope_has_pinned']) === 1,
    });
  }
  if (key.startsWith('c:')) {
    const peer = peerCallKeyOf(key);
    if (!peer) return null;
    return peerCallEntryOf(peer, readPeerCallTarget(sql, peer.tenantId, peer.callerScopeId, peer.callerVertical, peer.vertical));
  }
  if (key.startsWith('v:')) {
    const r = sql.exec(SERVING_POLICY_SQL, key.slice(2)).toArray()[0] as Record<string, unknown> | undefined;
    if (!r) return null;
    return servingPolicyEntryOf({
      serving_ref: r['serving_ref'] as Text,
      outbound_json: r['outbound_json'] as Text,
      calls_json: r['calls_json'] as Text,
      scope_stores_json: r['scope_stores_json'] as Text,
    });
  }
  return null;
}

const kvKeyOf = (key: string): string =>
  key.startsWith('h:')
    ? routeKvKey(key.slice(2))
    : key.startsWith('c:')
      ? `route/v${ROUTE_READ_MODEL_VERSION}/c/${key.slice(2)}`
      : servingPolicyKvKey(key.slice(2));

async function digestOf(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(bytes.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** One flush's account. `remaining` > 0 means it stopped at its bound, not that it failed. */
export interface RouteReadModelFlush {
  written: number;
  deleted: number;
  unchanged: number;
  /** Keys whose directory read threw (a malformed manifest): published as absent, logged. */
  unreadable: number;
  remaining: number;
  /** It stopped because the source was busy (`quiet()` false); the source restarts it. */
  deferred: boolean;
}

export interface RouteReadModelStatus {
  enabled: boolean;
  /** Dirty keys not yet published. */
  outbox: number;
  published: number;
  /** Hostnames a complete read model holds a ROUTE for: the projection's own gates (`routeEntryOf`). */
  routable: number;
  /** Hostnames it holds a REFUSAL for: active themselves, unpinned, their scope or tenant not active. */
  refused: number;
  /** Active hostnames it holds nothing for, left to the directory: pinned, or naming a pinned sibling (K-36). */
  pinned: number;
  verticals: number;
  /** Peer-call answers published (published only on a router's request). */
  peerCalls: number;
}

const FLUSH_BATCH = 100;
const FLUSH_CONCURRENCY = 8;

export class RouteReadModelPublisher {
  private readonly ledger: PublishedLedger;

  constructor(
    private readonly sql: Sql,
    private readonly kv: RouteKvWriter,
  ) {
    this.ledger = sqlPublishedLedger(sql);
  }

  /**
   * Create the tables and triggers. True when the triggers were not there before: the read model
   * was just switched on (or the directory was just rebuilt), so nothing published can be trusted
   * to match, and the caller marks every key dirty.
   */
  install(): boolean {
    for (const stmt of TABLES_DDL) this.sql.exec(stmt);
    const present = new Set(
      (this.sql.exec(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name GLOB 'rrm_*'`).toArray() as Array<{ name: string }>).map((r) => r.name),
    );
    let fresh = false;
    for (const [name, ddl] of TRIGGERS) {
      if (present.has(name)) continue;
      this.sql.exec(`CREATE TRIGGER IF NOT EXISTS ${name} ${ddl}`);
      fresh = true;
    }
    // The peer triggers arrived after the route ones. Adding them to a directory whose routes are
    // already published must not re-mark every route: only the peer answers (none, the first time)
    // could have missed a change while they were absent.
    let peerFresh = false;
    for (const [name, ddl] of PEER_TRIGGERS) {
      if (present.has(name)) continue;
      this.sql.exec(`CREATE TRIGGER IF NOT EXISTS ${name} ${ddl}`);
      peerFresh = true;
    }
    if (peerFresh && !fresh) this.sql.exec(append(`SELECT key FROM route_read_model_published WHERE ${ALL_PEER_KEYS}`));
    return fresh;
  }

  /** Every key the directory could publish, and every key KV may still hold. */
  markAll(): void {
    this.sql.exec(append(`SELECT 'h:' || hostname FROM hostnames WHERE status = 'active'`));
    this.sql.exec(append(`SELECT 'v:' || slug FROM verticals`));
    this.sql.exec(append(`SELECT key FROM route_read_model_published`));
  }

  /**
   * The router's miss (`readRoute(…, { publish: true })`): queue the route and its policy, unless
   * they are published already and only KV's propagation is behind — then a queue write per
   * request would buy nothing.
   */
  requestPublish(hostname: string): void {
    const r = this.sql
      .exec(
        `SELECT h.region, s.jurisdiction, s.serving_ref, s.vertical,
                EXISTS (SELECT 1 FROM hostnames WHERE scope_id = s.scope_id AND status = 'active' AND region IS NOT NULL) AS mixed
           FROM hostnames h JOIN scopes s ON s.scope_id = h.scope_id WHERE h.hostname = ?`,
        hostname,
      )
      .toArray()[0] as { region: Text; jurisdiction: Text; serving_ref: Text; vertical: Text; mixed: number } | undefined;
    // A route never published (K-36: pinned, or naming a pinned sibling): queueing it on every
    // request would buy nothing.
    if (!r || r.region !== null || isPinned(r.jurisdiction) || Number(r.mixed) === 1) return;
    const vertical = r.serving_ref !== null ? r.vertical : null;
    const keys = [`h:${hostname}`, ...(vertical ? [`v:${vertical}`] : [])];
    for (const key of keys) {
      const known = this.sql.exec('SELECT 1 FROM route_read_model_published WHERE key = ?', key).toArray().length > 0;
      if (!known) this.sql.exec('INSERT INTO route_read_model_outbox (key) VALUES (?)', key);
    }
  }

  /**
   * The router's peer-call miss (`peerCallTarget(…, { publish: true })`): queue the answer, and its
   * target's serving policy, when the answer dispatches and is not published already. A refusal or a
   * pinned call has no entry to publish, so queueing it would buy nothing.
   */
  requestPeerPublish(key: PeerCallKey, read: { row: PeerCallTargetRow; source: PeerCallTargetSource }): void {
    const entry = peerCallEntryOf(key, read);
    if (!entry) return;
    const keys: string[] = [peerCallEntryKey(key)];
    if (entry.target.dispatch.kind === 'serving') keys.push(servingPolicyEntryKey(entry.target.vertical));
    for (const k of keys) {
      const known = this.sql.exec('SELECT 1 FROM route_read_model_published WHERE key = ?', k).toArray().length > 0;
      if (!known) this.sql.exec('INSERT INTO route_read_model_outbox (key) VALUES (?)', k);
    }
  }

  pending(): boolean {
    return this.sql.exec('SELECT 1 FROM route_read_model_outbox LIMIT 1').toArray().length > 0;
  }

  /**
   * Publish up to `maxKeys` dirty keys. Throws when KV refuses a write, once every write it started
   * has settled: what was published stays published and out of the outbox, the rest is still dirty,
   * and no write of this flush is still in flight to race the next one.
   *
   * `quiet` is asked before each group of keys is read: entries are computed synchronously from the
   * source, and a source whose own call is still in flight may be inside a transaction that has not
   * committed. A flush that meets a busy source stops (`deferred`) and is restarted by the source.
   */
  async flush(maxKeys = 1_000, quiet: () => boolean = () => true): Promise<RouteReadModelFlush> {
    const out: RouteReadModelFlush = { written: 0, deleted: 0, unchanged: 0, unreadable: 0, remaining: 0, deferred: false };
    // A key KV refused goes to the back of the outbox and is not tried again in this flush, so one
    // failing key never holds back the changes queued behind it; the caller's retry (the alarm) tries
    // it again. The flush still throws at its end, once every write it started has settled.
    const failed = new Map<string, unknown>();
    let done = 0;
    outer: while (done < maxKeys) {
      const batch = this.sql
        .exec(
          // The oldest rows first, THEN grouped: a GROUP BY over the whole outbox would read every row
          // per batch. The limit is a row budget, so a batch may hold fewer keys; later rows of a key
          // stay for a later batch (publishOne deletes only up to the id it read).
          `SELECT key, MAX(id) AS id FROM (SELECT id, key FROM route_read_model_outbox ORDER BY id LIMIT ?)
            GROUP BY key ORDER BY MIN(id)`,
          Math.min(FLUSH_BATCH, maxKeys - done),
        )
        .toArray() as Array<{ key: string; id: number }>;
      const eligible = batch.filter((item) => !failed.has(item.key));
      // Only keys that already failed are left at the front: everything else has been tried.
      if (eligible.length === 0) break;
      for (let i = 0; i < eligible.length; i += FLUSH_CONCURRENCY) {
        if (!quiet()) {
          out.deferred = true;
          break outer;
        }
        const group = eligible.slice(i, i + FLUSH_CONCURRENCY);
        const settled = await Promise.allSettled(group.map((item) => this.publishOne(item, out)));
        settled.forEach((r, j) => {
          if (r.status !== 'rejected') return;
          const { key, id } = group[j]!;
          failed.set(key, r.reason);
          // To the back: a fresh row behind everything queued, the rows this attempt read removed.
          this.sql.exec('INSERT INTO route_read_model_outbox (key) VALUES (?)', key);
          this.sql.exec('DELETE FROM route_read_model_outbox WHERE key = ? AND id <= ?', key, id);
        });
        done += group.length;
      }
    }
    out.remaining = Number((this.sql.exec('SELECT COUNT(DISTINCT key) AS n FROM route_read_model_outbox').one() as { n: number }).n);
    if (failed.size > 0) {
      const [first] = failed.values();
      throw new Error(`route read model: KV refused ${failed.size} key(s); retried from the alarm. First: ${String(first)}`);
    }
    return out;
  }

  /**
   * The ledger describes the namespace it was confirmed against, or its confirmations are withdrawn
   * (see `ROUTE_LEDGER_MARKER_KEY`). True when they were, and every key queued to be published again.
   */
  async verifyNamespace(): Promise<boolean> {
    const stored = (this.sql.exec('SELECT after FROM route_read_model_cursor WHERE source = ?', LEDGER_SOURCE).toArray()[0] as
      | { after: string }
      | undefined)?.after;
    const marker = await this.kv.get(ROUTE_LEDGER_MARKER_KEY);
    if (stored && marker === stored) return false;
    const id = marker ?? crypto.randomUUID();
    if (marker === null) await this.kv.put(ROUTE_LEDGER_MARKER_KEY, id);
    // Every confirmation becomes uncertain rather than gone: a present entry is written again, and a
    // key the directory no longer routes is deleted (a no-op in a fresh namespace), so the reset also
    // leaves nothing behind if the namespace was the same one after all.
    this.sql.exec('UPDATE route_read_model_published SET digest = ?', UNCERTAIN_DIGEST);
    this.markAll();
    this.sql.exec(
      `INSERT INTO route_read_model_cursor (source, after) VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET after = excluded.after`,
      LEDGER_SOURCE, id,
    );
    return true;
  }

  private async publishOne({ key, id }: { key: string; id: number }, out: RouteReadModelFlush): Promise<void> {
    let value: Entry | null;
    try {
      value = computeRouteReadModelEntry(this.sql, key);
    } catch (err) {
      // A directory row the read cannot parse: the router's own read throws on it too. Absent is
      // the safe entry — the router then asks the directory, as it does today.
      console.error(`route read model: ${key} could not be read; publishing it as absent`, err);
      value = null;
      out.unreadable += 1;
    }
    const outcome = await writeRouteReadModelEntry({ kv: this.kv, ledger: this.ledger }, key as RouteReadModelKey, value);
    out[outcome] += 1;
    // Only up to the row this publish read: a change landed meanwhile keeps its own row.
    this.sql.exec('DELETE FROM route_read_model_outbox WHERE key = ? AND id <= ?', key, id);
  }

  /**
   * One slice of the drift repair, for the scheduled pass: up to `limit` keys from each source
   * (active hostnames, verticals, published keys), resuming where the last pass stopped. A key
   * whose entry differs from what was published is queued. Returns how many were queued.
   */
  async reconcile(limit = 500): Promise<{ checked: number; queued: number }> {
    let checked = 0;
    let queued = 0;
    const sources: Array<[source: string, sql: string]> = [
      ['h', `SELECT hostname AS k FROM hostnames WHERE hostname > ? ORDER BY hostname LIMIT ?`],
      ['v', `SELECT slug AS k FROM verticals WHERE slug > ? ORDER BY slug LIMIT ?`],
      ['p', `SELECT key AS k FROM route_read_model_published WHERE key > ? ORDER BY key LIMIT ?`],
    ];
    for (const [source, select] of sources) {
      const after = (this.sql.exec('SELECT after FROM route_read_model_cursor WHERE source = ?', source).toArray()[0] as { after: string } | undefined)?.after ?? '';
      const rows = this.sql.exec(select, after, limit).toArray() as Array<{ k: string }>;
      for (const { k } of rows) {
        const key = source === 'p' ? k : `${source}:${k}`;
        checked += 1;
        let value: Entry | null;
        try {
          value = computeRouteReadModelEntry(this.sql, key);
        } catch {
          value = null; // the flush publishes an unreadable key as absent, so compare it as that
        }
        if (await routeReadModelEntryDiffers(this.ledger, key as RouteReadModelKey, value)) {
          this.sql.exec('INSERT INTO route_read_model_outbox (key) VALUES (?)', key);
          queued += 1;
        }
      }
      // A short page is the end of the source: the next pass starts it again from the top.
      const next = rows.length < limit ? '' : rows[rows.length - 1]!.k;
      this.sql.exec(
        `INSERT INTO route_read_model_cursor (source, after) VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET after = excluded.after`,
        source, next,
      );
    }
    return { checked, queued };
  }

  status(): RouteReadModelStatus {
    const n = (q: string): number => Number((this.sql.exec(q).one() as { n: number }).n);
    // The same gates `ROUTE_ENTRY_SQL` / `REFUSED_ROUTE_SQL` and `routeEntryOf` apply, so the dry
    // run's "complete" is what publishing would actually write.
    const unpinned = `h.region IS NULL AND (s.jurisdiction IS NULL OR s.jurisdiction = 'global')`;
    const routes = `EXISTS (SELECT 1 FROM scopes rs JOIN tenants rt ON rt.tenant_id = rs.tenant_id
                     WHERE rs.scope_id = h.scope_id AND rs.tenant_id = h.tenant_id
                       AND rs.status = 'active' AND rt.status = 'active')`;
    const routable = n(
      `SELECT COUNT(*) AS n FROM hostnames h JOIN scopes s ON s.scope_id = h.scope_id
        WHERE h.status = 'active' AND ${unpinned} AND ${routes}
          AND NOT EXISTS (SELECT 1 FROM hostnames p WHERE p.scope_id = h.scope_id AND p.status = 'active' AND p.region IS NOT NULL)`,
    );
    const refused = n(
      `SELECT COUNT(*) AS n FROM hostnames h LEFT JOIN scopes s ON s.scope_id = h.scope_id
        WHERE h.status = 'active' AND ${unpinned} AND NOT ${routes}`,
    );
    return {
      enabled: true,
      outbox: n('SELECT COUNT(DISTINCT key) AS n FROM route_read_model_outbox'),
      published: n('SELECT COUNT(*) AS n FROM route_read_model_published'),
      routable,
      refused,
      pinned: n(`SELECT COUNT(*) AS n FROM hostnames WHERE status = 'active'`) - routable - refused,
      verticals: n('SELECT COUNT(*) AS n FROM verticals'),
      peerCalls: n(`SELECT COUNT(*) AS n FROM route_read_model_published WHERE ${ALL_PEER_KEYS}`),
    };
  }
}

/**
 * Switch the read model off on a directory that had it: drop the triggers and the outbox, so
 * nothing queues for a binding that is gone. The published ledger stays — it still describes KV,
 * and switching back on marks every key dirty, which reconciles the two.
 */
export function uninstallRouteReadModel(sql: Sql): void {
  for (const name of ROUTE_READ_MODEL_TRIGGERS) sql.exec(`DROP TRIGGER IF EXISTS ${name}`);
  const hasOutbox = sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'route_read_model_outbox'`).toArray().length > 0;
  if (hasOutbox) sql.exec('DELETE FROM route_read_model_outbox');
}
