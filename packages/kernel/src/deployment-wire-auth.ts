/**
 * The capability record (RFC wire-signing §7, Q8), as statements both adapters run against their
 * directory: one row per deployment, the script an upload went to (a version's archive script or a
 * vertical's serving script), holding what that upload gave it. Every upload of the script replaces
 * its row, so the row is the last upload's: the one the running script was built from. Written once
 * so the two adapters cannot keep different records of the same fleet.
 *
 * The uploader writes it from what it built and injected; a vertical never declares it, since a
 * claim a version makes about itself proves nothing. The readiness report (follow-on 4) reads it.
 * A vertical's rows go with the vertical (`forgetVerticalWireAuth`), so none outlives what it
 * describes.
 */
import { deploymentWireAuth, LIST_PAGE_MAX, substratError, tenantId, type DeploymentWireAuth, type TenantId } from '@substrat-run/contracts';
import type { SwitchSql } from './system-switch.js';

export type { DeploymentWireAuthInput } from '@substrat-run/contracts';

/** Interpolated into both adapters' directory DDL, so the two spell one table. */
export const DEPLOYMENT_WIRE_AUTH_DDL = `
  CREATE TABLE IF NOT EXISTS vertical_wire_auth (
    deployment_ref TEXT PRIMARY KEY,
    vertical_slug  TEXT NOT NULL,
    version_id     TEXT,
    record         TEXT NOT NULL,
    recorded_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS vertical_wire_auth_slug ON vertical_wire_auth (vertical_slug);
`;

/**
 * Whose records a read may return: the verticals one tenant owns now (`verticals.owner_tenant`), or
 * the whole fleet, said in so many words. There is no default, so a reader that forgets to confine
 * itself is refused rather than handed every tenant's deployments: a record names scripts, versions
 * and key ids, and a tenant reads only its own. A record of a platform-owned vertical (no owning
 * tenant) is reached only by the fleet.
 *
 * A tenant reach follows the vertical's current owner: it is resolved at read time, so whoever owns
 * the slug then reads every record the table holds for it, and a tenant that no longer owns it reads
 * none. Apart from a whole-directory restore (`restoreDirectory`), which replaces the owners and the
 * records together from one dump, no host path moves the owner of a registered vertical today: an
 * owner changes by deleting the vertical, which removes its records, and registering the slug again.
 * A record is written only beside its vertical's registration (`writeDeploymentWireAuth`), so a new
 * registrant of a slug reads only what was recorded since it registered. Key ids are not secrets.
 */
export type DeploymentWireAuthReach = { readonly tenantId: TenantId } | { readonly fleet: true };

/**
 * Which records a read returns, one page of them: the keyset convention by script name, `cursor` the
 * last name of the page before. A version's script keeps its record for as long as its vertical
 * exists, so a read is always a page: `limit` is required, at most `LIST_PAGE_MAX`.
 */
export interface DeploymentWireAuthFilter {
  readonly reach: DeploymentWireAuthReach;
  readonly verticalSlug?: string;
  readonly limit: number;
  readonly cursor?: string;
  readonly order?: 'asc' | 'desc';
}

const refused = (message: string) => substratError('validation_failed', message);

/** The longest `verticalSlug` or `cursor` a read takes. A script name is far shorter. */
export const WIRE_AUTH_FILTER_TEXT_MAX = 256;

const FILTER_KEYS: ReadonlySet<string> = new Set(['reach', 'verticalSlug', 'limit', 'cursor', 'order']);

/** The longest caller-supplied key name a refusal echoes, so its text stays bounded. */
const ECHOED_KEY_MAX = 64;
const echoedKey = (key: string): string => (key.length > ECHOED_KEY_MAX ? `${key.slice(0, ECHOED_KEY_MAX)}…` : key);
const REACH_REFUSAL = 'a capability-record read names its reach: one tenant ({ tenantId }) or the fleet ({ fleet: true }), exactly one';

/**
 * The filter a read is allowed to run, or a `validation_failed` refusal: only the filter's own keys;
 * a reach that is exactly one tenant (a tenant id) or exactly the fleet; a limit from 1 to
 * `LIST_PAGE_MAX`; a vertical and a cursor of 1 to `WIRE_AUTH_FILTER_TEXT_MAX` characters; an order
 * of `asc` or `desc`. Both adapters judge it before the read, and the Cloudflare host before the call
 * into the directory's object, so the refusal keeps its code across the RPC.
 *
 * Answers a NEW object built from the judged fields alone, never the caller's, so nothing else crosses
 * the RPC or reaches the access log. `reach` is its first key: the log keeps a read's params cut to a
 * bounded length, and nothing after the reach can push it out of what is kept.
 */
export function assertWireAuthFilter(filter: unknown): DeploymentWireAuthFilter {
  if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) {
    throw refused('a capability-record read needs a filter naming its reach and its limit');
  }
  // Own properties only: a field inherited from a prototype, a polluted one included, is not the caller's.
  const own = (o: object, key: string): unknown => (Object.hasOwn(o, key) ? (o as Record<string, unknown>)[key] : undefined);
  const extra = Object.keys(filter).filter((key) => !FILTER_KEYS.has(key));
  if (extra.length > 0) {
    throw refused(`a capability-record read takes reach, verticalSlug, limit, cursor and order; not ${extra.slice(0, 3).map(echoedKey).join(', ')}`);
  }
  const r = own(filter, 'reach');
  if (typeof r !== 'object' || r === null || Array.isArray(r)) throw refused(REACH_REFUSAL);
  const keys = Object.keys(r);
  if (keys.length !== 1) throw refused(REACH_REFUSAL);
  const value = own(r, keys[0]!);
  let reach: DeploymentWireAuthReach;
  if (keys[0] === 'fleet' && value === true) reach = { fleet: true };
  else if (keys[0] === 'tenantId' && tenantId.safeParse(value).success) reach = { tenantId: tenantId.parse(value) };
  else throw refused(REACH_REFUSAL);
  const limit = own(filter, 'limit');
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > LIST_PAGE_MAX) {
    throw refused(`limit must be an integer from 1 to ${LIST_PAGE_MAX}, got ${typeof limit === 'number' ? String(limit) : typeof limit}`);
  }
  const text = (name: 'verticalSlug' | 'cursor'): string | undefined => {
    const v = own(filter, name);
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || v.length === 0 || v.length > WIRE_AUTH_FILTER_TEXT_MAX) {
      throw refused(`${name} must be a string of 1 to ${WIRE_AUTH_FILTER_TEXT_MAX} characters`);
    }
    return v;
  };
  const verticalSlug = text('verticalSlug');
  const cursor = text('cursor');
  const order = own(filter, 'order');
  if (order !== undefined && order !== 'asc' && order !== 'desc') throw refused('order must be asc or desc');
  return {
    reach,
    ...(verticalSlug !== undefined ? { verticalSlug } : {}),
    limit,
    ...(cursor !== undefined ? { cursor } : {}),
    ...(order !== undefined ? { order } : {}),
  };
}

/** The access-log target of a read: the tenant a tenant reach names, none for the fleet. */
export function wireAuthAccessTarget(filter: DeploymentWireAuthFilter): { tenantId: TenantId | null } {
  return { tenantId: 'tenantId' in filter.reach ? filter.reach.tenantId : null };
}

/**
 * Record an upload's capability for its script, replacing the script's earlier record, and answer
 * whether it did. Takes the row the adapter parsed (`deploymentWireAuth`) before it reached here: on
 * Cloudflare that parse runs before the call into the directory's object, so a refusal keeps its code
 * across the RPC.
 *
 * Writes nothing, and answers `false`, for a vertical the registry does not hold: a record exists only
 * beside its vertical's registration, so no later registrant of a slug can read a record of an upload
 * made before it held it. Every upload records after its vertical is registered (a push registers,
 * then publishes, then records; a serve runs for a registered vertical), so this refuses only a write
 * that raced the vertical's delete. Judged in the caller's transaction, beside the write it guards; the
 * adapter turns `false` into `not_found`.
 */
export function writeDeploymentWireAuth(db: SwitchSql, row: DeploymentWireAuth): boolean {
  if (db.all('SELECT 1 FROM verticals WHERE slug = ?', row.verticalSlug).length === 0) return false;
  db.run(
    `INSERT INTO vertical_wire_auth (deployment_ref, vertical_slug, version_id, record, recorded_at)
       VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (deployment_ref) DO UPDATE SET
       vertical_slug = excluded.vertical_slug,
       version_id = excluded.version_id,
       record = excluded.record,
       recorded_at = excluded.recorded_at`,
    row.deploymentRef,
    row.verticalSlug,
    row.versionId,
    JSON.stringify(row.record),
    row.recordedAt,
  );
  return true;
}

/**
 * One page of the stored records the filter reaches, by script name. The filter is judged here too
 * (`assertWireAuthFilter`), so no caller reaches the table unconfined or unbounded. A row that does
 * not parse throws: it is a corrupt directory, not a fact.
 */
export function deploymentWireAuthOf(db: SwitchSql, input: DeploymentWireAuthFilter): DeploymentWireAuth[] {
  const filter = assertWireAuthFilter(input);
  const desc = filter.order === 'desc';
  const where: string[] = [];
  const params: (string | number)[] = [];
  if ('tenantId' in filter.reach) {
    where.push('vertical_slug IN (SELECT slug FROM verticals WHERE owner_tenant = ?)');
    params.push(filter.reach.tenantId);
  }
  if (filter.verticalSlug !== undefined) {
    where.push('vertical_slug = ?');
    params.push(filter.verticalSlug);
  }
  if (filter.cursor) {
    where.push(desc ? 'deployment_ref < ?' : 'deployment_ref > ?');
    params.push(filter.cursor);
  }
  params.push(filter.limit);
  const rows = db.all(
    'SELECT deployment_ref, vertical_slug, version_id, record, recorded_at FROM vertical_wire_auth' +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY deployment_ref ${desc ? 'DESC' : 'ASC'} LIMIT ?`,
    ...params,
  );
  return rows.map((r) =>
    deploymentWireAuth.parse({
      deploymentRef: r['deployment_ref'],
      verticalSlug: r['vertical_slug'],
      versionId: r['version_id'],
      record: JSON.parse(String(r['record'])),
      recordedAt: r['recorded_at'],
    }),
  );
}

/**
 * One pass of the fleet walk (RFC wire-signing follow-on 4), as its `walkWireAuth` admin row: whether
 * it applied or only reported, the cursor it started from and the one it ended at, how many scripts it
 * walked, and by name the scripts it updated, held, released and failed on. Script names and reasons
 * only, never a key or a binding's value.
 */
export interface WireWalkAudit {
  readonly apply: boolean;
  /** A confirming pass, which read every recorded script rather than trusting its record. */
  readonly confirm: boolean;
  readonly from: string | null;
  /** Where the next pass starts; `null` at the end of the fleet, or when the pass ended in an error. */
  readonly next: string | null;
  /** Scripts walked, counted to where the pass ended, an error included. */
  readonly walked: number;
  readonly updated: readonly string[];
  readonly held: readonly string[];
  readonly released: readonly string[];
  readonly skipped: readonly { readonly deploymentRef: string; readonly reason: string }[];
  readonly failed: readonly { readonly deploymentRef: string; readonly reason: string }[];
  /** Set when the pass ended in an error: the fixed text a person reads, never an upstream message. */
  readonly error?: string;
  /**
   * Set when the pass was refused before it walked anything, because the settings it would give are
   * refused (the rollout setting does not parse, or the lists do not load): the setting and the
   * problem, never a key.
   */
  readonly refused?: string;
}

/** Forget a vertical's records, with the vertical. */
export function forgetVerticalWireAuth(db: SwitchSql, verticalSlug: string): void {
  db.run('DELETE FROM vertical_wire_auth WHERE vertical_slug = ?', verticalSlug);
}
