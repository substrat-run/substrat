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

import { scopeDumpTable, z } from '@substrat-run/contracts';
import type {
  DirectoryBackup,
  DirectoryDump,
  ScopeBackup,
  ScopeBackupIndex,
  ScopeBackupObject,
  ScopeDump,
  ScopeDumpTable,
} from '@substrat-run/contracts';

/** What a backup's scope object and each of its page objects hold. */
export const storedTables = z.object({ tables: z.array(scopeDumpTable) });

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
  /**
   * One backup's dump, by its capture time. Null when no such copy is held: objects written with no
   * index are not a backup. A backup held in parts (D-69) comes back with its scope's tables and
   * `storePages` naming its stores' page objects, never their rows.
   */
  get(input: BackupAddress): Promise<ScopeDump | null>;

  // A backup held in parts (D-69): the scope's tables and each store's pages as objects of their own
  // under the backup's key, and last the index, which is what `list` and `get` see. No call here
  // holds more than one page.

  /** The scope's own (sealed) tables, as one object beside the pages, under a key of this attempt's own. */
  putScopeTables(input: BackupAddress & { tables: ScopeDumpTable[] }): Promise<ScopeBackupObject & { tables: number }>;
  /** One page of one chain, at its place. Written again in place, so a resumed step may repeat it. */
  putStorePage(input: BackupAddress & { moveId: string; seq: number; body: string }): Promise<void>;
  /** The first `pages` pages of a chain, in order: key, size and digest, from a listing. No page is read. */
  listStorePages(input: BackupAddress & { moveId: string; pages: number }): Promise<ScopeBackupObject[]>;
  /** Write the index: the one write that makes the objects a backup. Durable before it returns. */
  putIndex(input: { vertical: string | null; index: ScopeBackupIndex }): Promise<ScopeBackup>;
  /** A backup's index, or null when none is held, or the backup holds its stores inline. */
  getIndex(input: BackupAddress): Promise<ScopeBackupIndex | null>;
  /**
   * An object of this backup, checked against `ref`'s size and digest. Null when it is missing;
   * one that does not match, or lies outside this backup, refuses (422).
   */
  readObject(input: BackupAddress & { ref: ScopeBackupObject }): Promise<string | null>;
  /** Drop one chain's pages. Missing is not an error. */
  deleteMove(input: BackupAddress & { moveId: string }): Promise<void>;
  /**
   * Drop what one attempt at a backup wrote: its scope object, its chains' pages, and the index only
   * if the index names that scope object. Two attempts in one millisecond share an address and no
   * object, so one giving up never takes the other's. The last index written is the backup.
   */
  deleteAttempt(input: BackupAddress & { scopeKey?: string | undefined; moveIds: readonly string[] }): Promise<void>;
}

/** Where a backup is: its address, which only the store turns into a key. */
export interface BackupAddress {
  tenantId: string;
  scopeId: string;
  capturedAt: string;
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
