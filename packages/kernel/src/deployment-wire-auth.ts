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
import { deploymentWireAuth, type DeploymentWireAuth, type ListPage } from '@substrat-run/contracts';
import { assertRowLimit } from './scope-host.js';
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
 * Which records a read returns: every one, or one vertical's, a page at a time when it asks for one
 * (the keyset convention: by script name, `cursor` the last name of the page before). A version's
 * script keeps its record for as long as its vertical exists, so a reader of the whole fleet pages.
 */
export interface DeploymentWireAuthFilter extends ListPage {
  readonly verticalSlug?: string;
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

/** The stored records, by script name. A row that does not parse throws: it is a corrupt directory, not a fact. */
export function deploymentWireAuthOf(db: SwitchSql, filter: DeploymentWireAuthFilter): DeploymentWireAuth[] {
  const desc = filter.order === 'desc';
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.verticalSlug !== undefined) {
    where.push('vertical_slug = ?');
    params.push(filter.verticalSlug);
  }
  if (filter.cursor) {
    where.push(desc ? 'deployment_ref < ?' : 'deployment_ref > ?');
    params.push(filter.cursor);
  }
  if (filter.limit !== undefined) params.push(assertRowLimit('limit', filter.limit));
  const rows = db.all(
    'SELECT deployment_ref, vertical_slug, version_id, record, recorded_at FROM vertical_wire_auth' +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY deployment_ref ${desc ? 'DESC' : 'ASC'}` +
      (filter.limit !== undefined ? ' LIMIT ?' : ''),
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
