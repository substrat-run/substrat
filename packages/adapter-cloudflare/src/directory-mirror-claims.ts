/**
 * The registry's claims, dual-written (K-68 step 3b, part 2; rfc/tenant-scale.md §7.3).
 *
 * The directory decides every uniqueness today (a tenant id, a slug, a hostname) and keeps deciding
 * it until 3e. After the split the REGISTRY holds those keys, claimed through the intent-first
 * crossing (`@substrat-run/kernel`'s `directory-crossing`). So the dual-write copies the claims too,
 * through that same helper, in the order §7.3 gives: the tenant's object, which decides, records the
 * crossing in the same transaction as the row that makes it; host code then claims and confirms in
 * the registry, and the object settles.
 *
 * What makes a claim, in a TENANT object (the registry's own copy of a row makes none):
 * - a `tenants` row the object did not hold: `tenant-id` and `tenant-slug` claims. A slug is never
 *   changed (no directory path updates it), so the slug claim's id is fixed per tenant;
 * - a `tenants` row moving to `reaped` (or arriving reaped): release the slug, tombstone the id, so an
 *   id is never reused (§7.3);
 * - a `hostnames` row the object did not hold: a `hostname` claim, its id unique per binding;
 * - a `hostnames` row deleted: release that binding's claim.
 *
 * A release is recorded in `directory_mirror_releases` beside the row that causes it, and dropped
 * only once the registry released it, or once nothing was claimed under its id (its crossing failed,
 * or was settled and the claim is gone). An open crossing keeps its release waiting.
 *
 * Because the directory already decided, a claim the registry refuses is a difference, not a
 * decision: the crossing settles `failed` with the refusal, the row is applied regardless, and 3d's
 * comparison reports it. The usual cause is a hostname moved between tenants whose release had not
 * reached the registry yet; the flush runs every release before any claim to make that rare.
 */
import {
  crossingIn,
  openCrossingsIn,
  recordCrossingIn,
  type ClaimNamespace,
  type SwitchSql,
} from '@substrat-run/kernel';
import type { MirrorChange, MirrorValue } from './directory-mirror.js';

export const MIRROR_CLAIMS_DDL = [
  `CREATE TABLE IF NOT EXISTS directory_mirror_releases (
     namespace   TEXT NOT NULL,
     claim_key   TEXT NOT NULL,
     claim_id    TEXT NOT NULL,
     tombstone   INTEGER NOT NULL,
     recorded_at TEXT NOT NULL,
     PRIMARY KEY (namespace, claim_key, claim_id)
   ) WITHOUT ROWID`,
];

/** How much open claim work one apply hands back to the sender. */
export const MIRROR_CLAIM_WORK_MAX = 20;

export interface MirrorRelease {
  namespace: ClaimNamespace;
  key: string;
  claimId: string;
  tombstone: boolean;
}

/** An object's open claim work, handed back with every apply so a later send retries it. */
export interface MirrorClaimWork {
  crossings: string[];
  releases: MirrorRelease[];
}

export const tenantIdCrossingOf = (tenantId: string): string => `mirror:tenant-id:${tenantId}`;
export const tenantSlugCrossingOf = (tenantId: string): string => `mirror:tenant-slug:${tenantId}`;
const hostnameCrossingOf = (hostname: string, version: number): string => `mirror:hostname:${hostname}:${version}`;

type Row = Record<string, MirrorValue>;

function recordRelease(sql: SqlStorage, release: MirrorRelease, at: string): void {
  sql.exec(
    `INSERT OR IGNORE INTO directory_mirror_releases (namespace, claim_key, claim_id, tombstone, recorded_at) VALUES (?, ?, ?, ?, ?)`,
    release.namespace, release.key, release.claimId, release.tombstone ? 1 : 0, at,
  );
}

/** The tables whose rows make claims, and so need the row before the change. */
export const CLAIMING_TABLES: ReadonlySet<string> = new Set(['tenants', 'hostnames']);

/**
 * Record the claim work one applied change makes, inside the transaction that applied it. `before`
 * is the object's row before the change, `change.row` after it (null for a delete).
 */
export function recordMirrorClaims(
  target: { sql: SqlStorage; kernelSql: SwitchSql; owner: string; nowMs: number },
  change: MirrorChange,
  before: Row | null,
  version: number,
): void {
  const after = change.row;
  const at = new Date(target.nowMs).toISOString();
  const record = (input: Parameters<typeof recordCrossingIn>[2]) => recordCrossingIn(target.kernelSql, target.owner, input);
  if (change.table === 'tenants') {
    const tenantId = String((after ?? before)?.['tenant_id'] ?? '');
    if (!tenantId) return;
    const slug = String((after ?? before)?.['slug'] ?? '');
    if (after && !before) {
      record({ crossingId: tenantIdCrossingOf(tenantId), kind: 'mirror-tenant-create', namespace: 'tenant-id', key: tenantId, holder: tenantId, jurisdiction: 'global', nowMs: target.nowMs });
      record({ crossingId: tenantSlugCrossingOf(tenantId), kind: 'mirror-tenant-create', namespace: 'tenant-slug', key: slug, holder: tenantId, nowMs: target.nowMs });
    }
    const reapedNow = after?.['status'] === 'reaped' && before?.['status'] !== 'reaped';
    if (reapedNow || (!after && before)) {
      recordRelease(target.sql, { namespace: 'tenant-slug', key: slug, claimId: tenantSlugCrossingOf(tenantId), tombstone: false }, at);
      recordRelease(target.sql, { namespace: 'tenant-id', key: tenantId, claimId: tenantIdCrossingOf(tenantId), tombstone: true }, at);
    }
    return;
  }
  if (change.table === 'hostnames') {
    if (after && !before) {
      const hostname = String(after['hostname']);
      record({
        crossingId: hostnameCrossingOf(hostname, version), kind: 'mirror-hostname-bind', namespace: 'hostname', key: hostname,
        holder: String(after['tenant_id']), scopeId: (after['scope_id'] as string | null) ?? null, nowMs: target.nowMs,
      });
    } else if (!after && before) {
      const hostname = String(before['hostname']);
      const held = target.sql
        .exec(
          `SELECT crossing_id FROM _substrat_directory_crossings WHERE owner = ? AND namespace = 'hostname' AND claim_key = ?
            ORDER BY created_at DESC, crossing_id DESC LIMIT 1`,
          target.owner, hostname,
        )
        .toArray()[0] as { crossing_id: string } | undefined;
      if (held) recordRelease(target.sql, { namespace: 'hostname', key: hostname, claimId: held.crossing_id, tombstone: false }, at);
    }
  }
}

/** The object's open claim work, bounded: crossings not yet settled, releases not yet done. */
export function mirrorClaimWork(sql: SqlStorage, kernelSql: SwitchSql, owner: string): MirrorClaimWork {
  const crossings = openCrossingsIn(kernelSql, owner, { updatedBefore: '9999-12-31T23:59:59.999Z', limit: MIRROR_CLAIM_WORK_MAX })
    .filter((c) => c.crossingId.startsWith('mirror:'))
    .map((c) => c.crossingId);
  const releases = (sql
    .exec(`SELECT namespace, claim_key, claim_id, tombstone FROM directory_mirror_releases ORDER BY recorded_at, claim_id LIMIT ?`, MIRROR_CLAIM_WORK_MAX)
    .toArray() as { namespace: ClaimNamespace; claim_key: string; claim_id: string; tombstone: number }[])
    .map((r) => ({ namespace: r.namespace, key: r.claim_key, claimId: r.claim_id, tombstone: r.tombstone === 1 }));
  return { crossings, releases };
}

/**
 * After the registry answered a release: drop it once it was released, or once nothing will ever be
 * claimed under its id (its crossing is settled, or was never recorded). Kept while its crossing is
 * open, so the claim that crossing is about to make is still released. True when it was dropped.
 */
export function settleMirrorReleaseIn(sql: SqlStorage, kernelSql: SwitchSql, owner: string, release: MirrorRelease, released: boolean): boolean {
  const crossing = crossingIn(kernelSql, owner, release.claimId);
  const open = crossing !== null && (crossing.state === 'intent' || crossing.state === 'claimed');
  if (!released && open) return false;
  sql.exec(
    `DELETE FROM directory_mirror_releases WHERE namespace = ? AND claim_key = ? AND claim_id = ?`,
    release.namespace, release.key, release.claimId,
  );
  return true;
}
