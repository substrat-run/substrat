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
import { deploymentWireAuth, LIST_PAGE_MAX, substratError, tenantId, type DeploymentWireAuth } from '@substrat-run/contracts';
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
 * and key ids, and a tenant reads only its own. A record whose vertical no tenant owns, or that the
 * registry does not know, is reached only by the fleet.
 */
export type DeploymentWireAuthReach = { readonly tenantId: string } | { readonly fleet: true };

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

/**
 * The filter a read is allowed to run, or a `validation_failed` refusal: a reach that is exactly one
 * tenant (a tenant id) or exactly the fleet, a limit from 1 to `LIST_PAGE_MAX`, and the optional
 * fields in their own types. Both adapters judge it before the read, and the Cloudflare host before
 * the call into the directory's object, so the refusal keeps its code across the RPC.
 */
export function assertWireAuthFilter(filter: unknown): DeploymentWireAuthFilter {
  if (typeof filter !== 'object' || filter === null) throw refused('a capability-record read needs a filter naming its reach and its limit');
  const f = filter as Record<string, unknown>;
  const reach = f['reach'];
  if (typeof reach !== 'object' || reach === null) throw refused('a capability-record read names its reach: one tenant ({ tenantId }) or the fleet ({ fleet: true })');
  const r = reach as Record<string, unknown>;
  const keys = Object.keys(r);
  const isTenant = keys.length === 1 && keys[0] === 'tenantId' && tenantId.safeParse(r['tenantId']).success;
  const isFleet = keys.length === 1 && keys[0] === 'fleet' && r['fleet'] === true;
  if (!isTenant && !isFleet) throw refused('a capability-record read names its reach: one tenant ({ tenantId }) or the fleet ({ fleet: true }), exactly one');
  const limit = f['limit'];
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > LIST_PAGE_MAX) {
    throw refused(`limit must be an integer from 1 to ${LIST_PAGE_MAX}, got ${String(limit)}`);
  }
  for (const name of ['verticalSlug', 'cursor'] as const) {
    if (f[name] !== undefined && (typeof f[name] !== 'string' || f[name] === '')) throw refused(`${name} must be a non-empty string`);
  }
  if (f['order'] !== undefined && f['order'] !== 'asc' && f['order'] !== 'desc') throw refused('order must be asc or desc');
  return filter as DeploymentWireAuthFilter;
}

/**
 * Record an upload's capability for its script, replacing the script's earlier record. Takes the row
 * the adapter parsed (`deploymentWireAuth`) before it reached here: on Cloudflare that parse runs
 * before the call into the directory's object, so a refusal keeps its code across the RPC.
 */
export function writeDeploymentWireAuth(db: SwitchSql, row: DeploymentWireAuth): void {
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

/** Forget a vertical's records, with the vertical. */
export function forgetVerticalWireAuth(db: SwitchSql, verticalSlug: string): void {
  db.run('DELETE FROM vertical_wire_auth WHERE vertical_slug = ?', verticalSlug);
}
