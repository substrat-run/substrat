/**
 * How long a fork-before-promote snapshot is kept (#3314, preview-and-snapshots.md §4).
 *
 * `bindScopeVersion(…, { snapshot: true })` copies a scope before a promote that crosses a
 * migration digest, so a bad version leaves a rollback point at the old frontier. That copy is a
 * full copy of the tenant's data, and its worth decays: restoring one taken weeks ago throws away
 * every write since. So it is born with an `expiresAt`, and the platform sweep's snapshot GC
 * reaps it like any expired fork, including a half-made one, since the directory row (and its
 * expiry) is written before the data is copied.
 *
 * Thirty days covers any realistic "this promote was bad" window and matches the point-in-time
 * history a rewind already offers. A snapshot someone means to keep is pinned with
 * `HostAdmin.setScopeExpiresAt(…, null)`. A manual snapshot (`snapshotScope` called directly) is
 * not this rule's business: it keeps whatever expiry its caller gave it.
 */
export const PRE_PROMOTE_SNAPSHOT_TTL_MS = 30 * 86_400_000;

/** The `expiresAt` a pre-promote snapshot taken at `nowMs` carries. */
export function prePromoteSnapshotExpiresAt(nowMs: number): string {
  return new Date(nowMs + PRE_PROMOTE_SNAPSHOT_TTL_MS).toISOString();
}
