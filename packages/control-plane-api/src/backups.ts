/**
 * The scope-backup write seam (#493) — where a reap's recoverable copy goes.
 *
 * A reap frees a scope's Durable Object storage because Cloudflare never garbage-
 * collects a DO, and it is irreversible. Before #493 the operator had to REMEMBER to
 * take a copy first, from a different surface; this seam is what makes "a reap always
 * leaves a recoverable copy" a property of the route instead of a habit.
 *
 * Why a dump and not a snapshot fork. The obvious cheap move — `orchestratedSnapshot`
 * before the reap — does not survive the case the flow exists for. A fork is provisioned
 * INSIDE the vertical's own deployment and activated, so (a) its bytes live in the very
 * deployment a retirement is about to delete, and (b) it counts as a live scope in
 * `countScopesForVertical`, which means it re-blocks the `deleteVertical` the reap was
 * clearing. A dump leaves the deployment entirely, and `POST …/restore` already loads one
 * back, so export→store→restore is the round trip that actually closes.
 *
 * Provider-neutral by the same posture as `ObservabilityReader` and `DeployVerticalFn`:
 * the contract lives here, an implementation lives in its own module (`r2-backups.ts` for
 * Cloudflare R2), and the host injects one. A backup is addressed by (tenant, scope,
 * capturedAt) rather than by a store-shaped key, so the key scheme stays the store's
 * private business and no caller can build a path into someone else's tenant.
 *
 * Fidelity is deliberately FULL, never masked (#493). A masked dump has its PII redacted,
 * so restoring one produces a structurally-valid but factually wrong scope — a backup that
 * cannot restore is a false promise, and the promise is the whole point. This is not the
 * §6 governed pull: the bytes go platform→platform and are never handed to a caller, which
 * is why the export route's masking default does not apply here.
 */

import type { DirectoryBackup, DirectoryDump, ScopeBackup, ScopeDump } from '@substrat-run/contracts';

// `ScopeBackup` — the metadata shape a stored copy reports — is a WIRE shape (the reap
// response, the backups list, the console's table), so it lives in `contracts` beside
// `scopeDump` rather than here. Re-exported for callers that only import this seam.
export type { ScopeBackup, DirectoryBackup };

export interface ScopeBackupStore {
  /**
   * Store one full-fidelity dump and return its metadata. Must be durable before it
   * returns: the reap's whole guarantee is that this resolved before any byte was wiped.
   */
  put(input: { vertical: string | null; dump: ScopeDump }): Promise<ScopeBackup>;
  /** Every backup held for one scope, newest first. */
  list(input: { tenantId: string; scopeId: string }): Promise<ScopeBackup[]>;
  /** One backup's dump, by its capture time. Null when no such copy is held. */
  get(input: { tenantId: string; scopeId: string; capturedAt: string }): Promise<ScopeDump | null>;
}

/**
 * The DIRECTORY-backup store (#40) — the platform's own copy, not a tenant's.
 *
 * A sibling seam rather than a widened `ScopeBackupStore`, because the two are the same
 * mechanism serving different jobs and the difference is worth keeping in the types.
 * A scope backup is taken at a MOMENT — before a reap, before a migration — and is
 * addressed by the scope it came from. A directory backup is taken on a SCHEDULE, has
 * no tenant to be addressed by, and is pruned to a retention window. Only this one
 * needs `delete`, and only this one is ever written by a sweep with no operator behind
 * it.
 *
 * What it defends against is also different, and the distinction is the whole design
 * (#40's own analysis). Per-scope point-in-time recovery already covers corruption
 * inside the account — ~30 days, continuous, and strictly better than a daily copy, so
 * scheduled per-scope backups are deliberately NOT built. The directory is the case PITR
 * cannot answer: it is one Durable Object, and a bug that deletes it outright leaves
 * nothing to rewind. Copies live outside the DO for that reason.
 *
 * Honest scoping: with the store bound in the platform's OWN account (the shape shipped
 * today), this survives losing the directory, not losing the account. The seam is
 * provider-neutral so an off-account target is a drop-in — see control-plane.md §4.9.
 */
export interface DirectoryBackupStore {
  /**
   * Store one full-fidelity directory dump and return its metadata. Durable before it
   * returns, like the scope store's `put`.
   */
  put(input: { dump: DirectoryDump }): Promise<DirectoryBackup>;
  /** Every directory copy held, newest first. */
  list(): Promise<DirectoryBackup[]>;
  /** One copy's dump, by its capture time. Null when no such copy is held. */
  get(input: { capturedAt: string }): Promise<DirectoryDump | null>;
  /** Drop one copy — how the retention window is enforced. Missing is not an error. */
  delete(input: { capturedAt: string }): Promise<void>;
}
