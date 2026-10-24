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
import { deploymentWireAuth, type DeploymentWireAuth, type WireAuthRecord } from '@substrat-run/contracts';
import type { SwitchSql } from './system-switch.js';

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

/** What one upload records for the script it went to. */
export interface DeploymentWireAuthInput {
  readonly deploymentRef: string;
  readonly verticalSlug: string;
  readonly versionId: string | null;
  readonly record: WireAuthRecord;
  readonly recordedAt: string;
}

/** Which records a read returns: every one, or one vertical's. */
export interface DeploymentWireAuthFilter {
  readonly verticalSlug?: string;
}

/** Record an upload's capability for its script, replacing the script's earlier record. */
export function writeDeploymentWireAuth(db: SwitchSql, input: DeploymentWireAuthInput): void {
  const row = deploymentWireAuth.parse(input);
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
export function deploymentWireAuthOf(db: SwitchSql, filter: DeploymentWireAuthFilter = {}): DeploymentWireAuth[] {
  const rows =
    filter.verticalSlug === undefined
      ? db.all('SELECT deployment_ref, vertical_slug, version_id, record, recorded_at FROM vertical_wire_auth ORDER BY deployment_ref')
      : db.all(
          'SELECT deployment_ref, vertical_slug, version_id, record, recorded_at FROM vertical_wire_auth WHERE vertical_slug = ? ORDER BY deployment_ref',
          filter.verticalSlug,
        );
  return rows.map((r) =>
    deploymentWireAuth.parse({
      deploymentRef: r['deployment_ref'],
      verticalSlug: r['vertical_slug'],
      versionId: r['version_id'] ?? null,
      record: JSON.parse(String(r['record'])),
      recordedAt: r['recorded_at'],
    }),
  );
}

/** Forget a vertical's records, with the vertical. */
export function forgetVerticalWireAuth(db: SwitchSql, verticalSlug: string): void {
  db.run('DELETE FROM vertical_wire_auth WHERE vertical_slug = ?', verticalSlug);
}
