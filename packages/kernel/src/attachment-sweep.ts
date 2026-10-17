import { substratError } from '@substrat-run/contracts';
import type { ScopedSql, TenantBlobStore } from './scope-host.js';
import { attachmentBlobKey } from './scope-host.js';
import { ulidTime } from './ulid.js';

// Web-standard (Node, Workers, browsers); the kernel pulls in no platform lib typings.
declare const TextEncoder: new () => { encode(input: string): Uint8Array };
declare const TextDecoder: new () => { decode(input: Uint8Array): string };

/**
 * The orphan-byte sweep (#2314): delete attachment bytes that no `_substrat_attachments` row
 * points at, written ONCE for both adapters.
 *
 * An attachment write puts the bytes first and the row second, so a crash between the two, a
 * transport failure whose commit is unknown (#2311 keeps the bytes on doubt, K-54) and a PITR
 * rewind past a row all leave an object nobody reads. The one thing this sweep must never do is
 * delete bytes whose row committed, or whose row a restore can still bring back. Four guards
 * hold that, each on its own:
 *
 * 1. **A tombstone is the linearization point.** The scope does not delete; it CONDEMNS. In one
 *    scope transaction it records each candidate that has no row in `_substrat_attachment_condemned`,
 *    and the attachment insert refuses a condemned id in ITS transaction
 *    (`refuseCondemnedAttachment`). The scope serializes the two, so either the row commits first
 *    and the condemnation sees it and skips the id, or the condemnation commits first and the row
 *    is refused: the upload fails and nothing commits without its bytes. Only a condemned id's
 *    object is ever deleted. No clock and no timing is involved, so a slow upload, a retried call
 *    or a skewed clock cannot turn a committed row into a deleted object.
 * 2. **An age floor.** Only an object whose id (a ULID minted just before its `put`) is older than
 *    `graceMs` is a candidate, so an upload still in flight is never condemned in the first place
 *    and therefore never refused. The floor is courtesy, guard 1 is safety.
 * 3. **The restore fence.** A row a rewind or a dump restore took away can come back: PITR keeps
 *    every state of the last 30 days. Every path that replaces a scope's state writes a fence
 *    object into the tenant's blob store BEFORE it does (`fenceAttachmentSweep`), and the sweep
 *    deletes nothing of that scope until the fence is `fenceMs` old. The fence lives in the blob
 *    store, never in the scope, because the rewind it records would erase it there. It is read
 *    before the pass and again after the condemnation, immediately before the first delete, so a
 *    rewind that lands mid-pass stops the deletes. A fence that cannot be read is a fence.
 * 4. **The serving copy only, and only while it is live.** The judgement is only as good as the
 *    copy that makes it. A host refuses a scope that is not active, a store that holds nothing, a
 *    copy a carry wiped or kept, a fork, and a scope not provisioned for the tenant. It also
 *    refuses while another script's copy of the scope is unsettled in the copy ledger
 *    (any state but `SETTLED_COPY_STATES`), because that copy may hold rows the serving one lacks. Which
 *    deployment is asked is the driver's business: the platform asks the one serving the scope.
 *
 * The instant a pass judges age and the fence against is the HOST's clock, never a caller's
 * (`OrphanSweepRequest` carries none), so no caller can step past guard 2 or guard 3.
 *
 * A dry run condemns nothing and deletes nothing: it reports what a pass would condemn.
 */

/** The tombstone table, shared by both adapters so the two cannot part company. */
export const ATTACHMENT_CONDEMNED_DDL = `
  CREATE TABLE IF NOT EXISTS _substrat_attachment_condemned (
    -- The attachment id whose object the sweep deleted, or is about to. No row may ever be
    -- inserted for it again: the insert path refuses it (#2314).
    id TEXT PRIMARY KEY,
    condemned_at TEXT NOT NULL
  );
`;

/** The refusal reason an upload meets when its id was condemned before its row could commit. */
export const ATTACHMENT_CONDEMNED = 'attachment_condemned';

/** How old an object must be before a pass looks at it, by default: seven days. */
export const ORPHAN_SWEEP_GRACE_MS = 7 * 86_400_000;

/**
 * How long a scope's bytes are left alone after its state was replaced, by default: 35 days. A
 * Durable Object keeps 30 days of point-in-time history, so a row a rewind took away can be
 * restored for that long; five more days absorb the clocks and the time a rewind takes to arm.
 */
export const ORPHAN_SWEEP_FENCE_MS = 35 * 86_400_000;

/** The most objects one pass deletes, by default. */
export const ORPHAN_SWEEP_LIMIT = 500;

/** The most ids one condemnation call carries: one JSON parameter, so no SQL limit applies. */
export const ORPHAN_CONDEMN_BATCH = 100;

/**
 * How long a tombstone is kept. Past this no upload that minted the id can still be in flight
 * (an upload holds its body in memory, and its call to the scope is one request), so the
 * tombstone guards nothing any more.
 */
export const ORPHAN_TOMBSTONE_RETENTION_MS = 30 * 86_400_000;

/**
 * Refuse an insert of a condemned attachment id. Called by both adapters inside the
 * attachment write's own transaction, before its `INSERT`, so it and the condemnation are
 * serialized by the scope (guard 1). A `conflict` is a refusal the scope ANSWERS, so the host
 * compensates the object away (it is already gone, or about to be) and the caller is told.
 */
export function refuseCondemnedAttachment(sql: ScopedSql, attachmentId: string): void {
  const condemned = sql.query('SELECT 1 AS hit FROM _substrat_attachment_condemned WHERE id = ?', [attachmentId]);
  if (condemned.length > 0) {
    throw substratError(
      'conflict',
      `attachment ${attachmentId}: its bytes were swept as an orphan before this row could commit; upload the file again`,
      { reason: ATTACHMENT_CONDEMNED },
    );
  }
}

/**
 * Refuse a dump load that would put back a row for an id this store has condemned (#2314). A
 * load is the other way an `_substrat_attachments` row is written, so it meets the same
 * tombstone the insert does: a restore that raced a pass must not land a row whose bytes that
 * pass is deleting. Called inside the load's transaction, BEFORE its first drop, against the
 * store as it is. A store with no tombstone table (from before #2314) has condemned nothing.
 */
export function refuseCondemnedInDump(
  sql: ScopedSql,
  tables: readonly { name: string; columns: readonly string[]; rows: readonly (readonly unknown[])[] }[],
): void {
  const has = sql.query(
    `SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = '_substrat_attachment_condemned'`,
  );
  if (has.length === 0) return;
  const ids: string[] = [];
  for (const table of tables) {
    if (table.name.toLowerCase() !== '_substrat_attachments') continue;
    const at = table.columns.indexOf('id');
    if (at < 0) continue;
    for (const row of table.rows) if (typeof row[at] === 'string') ids.push(row[at] as string);
  }
  for (let i = 0; i < ids.length; i += 500) {
    const hit = sql.query<{ id: string }>(
      `SELECT c.id AS id FROM _substrat_attachment_condemned c
        WHERE c.id IN (SELECT value FROM json_each(?)) ORDER BY c.id LIMIT 5`,
      [JSON.stringify(ids.slice(i, i + 500))],
    );
    if (hit.length > 0) {
      throw substratError(
        'conflict',
        `restore refused: the dump holds attachment rows whose bytes the orphan sweep condemned in this ` +
          `scope (${hit.map((h) => h.id).join(', ')}). Their bytes are gone or going; restore a dump taken ` +
          `after they were swept, or remove those rows from the dump`,
        { reason: ATTACHMENT_CONDEMNED },
      );
    }
  }
}

/** The ids in `ids` that no `_substrat_attachments` row names. Read-only. */
export function rowlessAttachmentIds(sql: ScopedSql, ids: readonly string[]): string[] {
  if (ids.length === 0) return [];
  return sql
    .query<{ value: string }>(
      `SELECT j.value AS value FROM json_each(?) AS j
        WHERE NOT EXISTS (SELECT 1 FROM _substrat_attachments a WHERE a.id = j.value)
        ORDER BY j.value`,
      [JSON.stringify(ids)],
    )
    .map((r) => r.value);
}

/**
 * Condemn the ids in `ids` that no row names, inside the caller's scope transaction (guard 1),
 * and return every id that is condemned and rowless now: the ones condemned here and the ones an
 * earlier pass condemned but did not get to delete. Only those may be deleted. Idempotent.
 *
 * Each returned id's tombstone is stamped `now`, re-stamped if an earlier pass condemned it, so
 * the prune of tombstones past `ORPHAN_TOMBSTONE_RETENTION_MS` that follows can never take the
 * tombstone of an id this pass is about to delete.
 */
export function condemnOrphanAttachments(sql: ScopedSql, ids: readonly string[], now: string): string[] {
  if (ids.length > ORPHAN_CONDEMN_BATCH) {
    throw new RangeError(`at most ${ORPHAN_CONDEMN_BATCH} ids are condemned at once, got ${ids.length}`);
  }
  const rowless = rowlessAttachmentIds(sql, ids);
  for (const id of rowless) {
    sql.exec(
      `INSERT INTO _substrat_attachment_condemned (id, condemned_at) VALUES (?, ?)
         ON CONFLICT (id) DO UPDATE SET condemned_at = excluded.condemned_at`,
      [id, now],
    );
  }
  const horizon = new Date(Date.parse(now) - ORPHAN_TOMBSTONE_RETENTION_MS).toISOString();
  sql.exec('DELETE FROM _substrat_attachment_condemned WHERE condemned_at < ?', [horizon]);
  return rowless;
}

/**
 * The copy-ledger states (#1722) in which another script's copy of a scope can no longer hold a
 * row the serving copy lacks, nor discover one. An ALLOWLIST: every other state, a future one
 * included, holds the pass. Only `done` qualifies: the copy was wiped (or found already wiped),
 * reaped with its scope, or is the move's destination, the copy that serves. Every other state can
 * still hold, or still turn up, a write the serving copy never saw:
 *
 * - `pending`: a move in flight; its outcome is not known yet.
 * - `eligible`: a carry's source awaiting its fenced wipe. The wipe is what discovers a write that
 *   landed after the export and turns the copy `kept`, and it is best effort, so until it has run
 *   the copy may hold an upload whose bytes share this scope's prefix.
 * - `kept`: such a write was found; staff resolve it.
 * - `retained`: a copy kept on purpose (a bind that did not land, a copy from before the ledger),
 *   whose contents nobody checked against the serving copy.
 */
export const SETTLED_COPY_STATES: readonly string[] = ['done'];

/** The refusal of a pass over a scope with a copy not yet settled, or null when there is none. */
export function unsettledCopyRefusal(scopeId: string, copies: readonly { state: string; scriptRef: string }[]): Error | null {
  const unsettled = copies.filter((c) => !SETTLED_COPY_STATES.includes(c.state));
  if (unsettled.length === 0) return null;
  return substratError(
    'conflict',
    `refused: scope ${scopeId} has a copy in another script that may hold rows this copy lacks ` +
      `(${unsettled.map((c) => `${c.scriptRef}: ${c.state}`).join(', ')}). Settle it (#1722) before its bytes are swept`,
  );
}

/**
 * What a pass throws when the deployment holds no attachment store for the tenant, yet the scope
 * holds attachment rows (#2314): its store binding is missing, which is a failure to fix, never the
 * `bucket: 'none'` of a scope that keeps no files.
 */
export function missingAttachmentStore(tenantId: string, scopeId: string): Error {
  return new Error(
    `scope ${scopeId} holds attachment rows, but this deployment holds no attachment store for tenant ${tenantId}: ` +
      'its store binding is missing. Re-push the vertical so the store is declared, then sweep again',
  );
}

/** The blob key of a scope's restore fence (guard 3). Outside `att/`, so no pass ever lists it. */
export function attachmentSweepFenceKey(scopeId: string): string {
  return `scope/${scopeId}/sweep-fence`;
}

/**
 * Record that a scope's state is about to be replaced (a PITR rewind, a dump restore), so no pass
 * deletes its bytes for `ORPHAN_SWEEP_FENCE_MS`. Call it BEFORE the replacement and let a throw
 * refuse the replacement: a rewind whose fence was not written could hand the sweep a state that
 * lacks rows a later restore brings back.
 */
export async function fenceAttachmentSweep(store: TenantBlobStore, scopeId: string, now: string): Promise<void> {
  await store.put(attachmentSweepFenceKey(scopeId), new TextEncoder().encode(now), { contentType: 'text/plain' });
}

/**
 * Until when the fence holds a scope's bytes, or null when there is no fence. A fence that
 * cannot be read or parsed is held to hold forever: the sweep fails closed.
 */
async function fencedUntil(store: TenantBlobStore, scopeId: string, fenceMs: number): Promise<number | null> {
  const fence = await store.get(attachmentSweepFenceKey(scopeId));
  if (!fence) return null;
  const at = Date.parse(new TextDecoder().decode(fence.body));
  if (!Number.isFinite(at)) return Number.POSITIVE_INFINITY;
  return at + fenceMs;
}

/**
 * What a caller asks of a host's pass (`ScopeHost.sweepOrphanAttachments`). No instant: the
 * host judges the age floor and the fence against its OWN clock, so no caller can step past
 * either by handing in a later time.
 */
export interface OrphanSweepRequest {
  /** Report what a pass would condemn and delete, and change nothing. */
  dryRun?: boolean;
  /** The most objects deleted in one pass. Default `ORPHAN_SWEEP_LIMIT`. */
  limit?: number;
  /**
   * A host with no directory (a CP-less deployment) cannot read the copy ledger, so it cannot see
   * a kept or pending copy of the scope in another version's script, whose rows the serving copy
   * lacks. It refuses unless its caller says it checked the ledger and found no such copy.
   */
  copiesSettled?: boolean;
}

/** The options the kernel's pass takes from its host: the request, and the host's clock. */
export interface OrphanSweepOptions {
  /** The instant the pass judges age and the fence against: the HOST's clock, never a caller's. */
  now: string;
  /** Report what a pass would condemn and delete, and change nothing. */
  dryRun?: boolean;
  /** Candidate age floor in ms. Default `ORPHAN_SWEEP_GRACE_MS`; never below one day. */
  graceMs?: number;
  /** How long a fence holds. Default `ORPHAN_SWEEP_FENCE_MS`; never below 31 days. */
  fenceMs?: number;
  /** The most objects deleted in one pass. Default `ORPHAN_SWEEP_LIMIT`. */
  limit?: number;
}

export interface OrphanSweepReport {
  /** Objects under the scope's attachment prefix. */
  listed: number;
  /** Objects old enough to be judged. */
  candidates: number;
  /** Objects whose id no row names: condemned (or, in a dry run, that would be). */
  orphans: number;
  /** Objects deleted. Always 0 in a dry run, and while fenced. */
  deleted: number;
  /** The keys deleted, or in a dry run the keys that would be. At most `limit`. */
  keys: string[];
  /** Set when the restore fence held the pass: the instant until which it holds. */
  fencedUntil?: string;
  dryRun: boolean;
  /**
   * `'none'` when the deployment holds no attachment store for the tenant at all, so nothing was
   * listed (#2314). Set apart from a pass that listed an empty store, so a store binding missing
   * from a vertical that does keep files cannot pass for a clean sweep.
   */
  bucket?: 'none';
}

/** What the scope side of a pass is: the read for a dry run, the condemnation otherwise. */
export interface OrphanSweepScope {
  rowless(ids: readonly string[]): Promise<string[]>;
  condemn(ids: readonly string[], now: string): Promise<string[]>;
}

/** The smallest grace a caller may ask for: an upload is one request, never a day. */
const MIN_GRACE_MS = 86_400_000;
/** The smallest fence a caller may ask for: the PITR window plus a day. */
const MIN_FENCE_MS = 31 * 86_400_000;

/**
 * One pass over one scope's attachment bytes. The host supplies the store and the scope side;
 * this decides, in this order: the fence, the candidates by age, the condemnation in batches,
 * the fence again, the deletes. Every failure before a delete leaves every object in place, and a
 * delete that fails leaves its tombstone, so the next pass finishes it.
 */
export async function sweepOrphanAttachments(
  store: TenantBlobStore,
  scopeId: string,
  scope: OrphanSweepScope,
  opts: OrphanSweepOptions,
): Promise<OrphanSweepReport> {
  const nowMs = Date.parse(opts.now);
  if (!Number.isFinite(nowMs)) throw new RangeError(`not an instant: ${opts.now}`);
  const graceMs = opts.graceMs ?? ORPHAN_SWEEP_GRACE_MS;
  const fenceMs = opts.fenceMs ?? ORPHAN_SWEEP_FENCE_MS;
  const limit = opts.limit ?? ORPHAN_SWEEP_LIMIT;
  if (!(graceMs >= MIN_GRACE_MS)) throw new RangeError(`graceMs must be at least ${MIN_GRACE_MS}, got ${graceMs}`);
  if (!(fenceMs >= MIN_FENCE_MS)) throw new RangeError(`fenceMs must be at least ${MIN_FENCE_MS}, got ${fenceMs}`);
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError(`limit must be a non-negative integer, got ${limit}`);
  const dryRun = opts.dryRun === true;
  const report: OrphanSweepReport = { listed: 0, candidates: 0, orphans: 0, deleted: 0, keys: [], dryRun };

  const fenced = async (): Promise<boolean> => {
    const until = await fencedUntil(store, scopeId, fenceMs);
    if (until === null || until <= nowMs) return false;
    report.fencedUntil = Number.isFinite(until) ? new Date(until).toISOString() : 'never';
    return true;
  };
  if (await fenced()) return report;

  const prefix = attachmentBlobKey(scopeId, '');
  const keys = await store.list(prefix);
  report.listed = keys.length;
  const cutoff = nowMs - graceMs;
  const candidates: string[] = [];
  for (const key of keys) {
    const id = key.slice(prefix.length);
    // Only a key this platform wrote for an attachment is judged: anything else is left alone.
    if (key !== attachmentBlobKey(scopeId, id)) continue;
    let minted: number;
    try {
      minted = ulidTime(id);
    } catch {
      continue;
    }
    if (minted <= cutoff) candidates.push(id);
  }
  report.candidates = candidates.length;

  const orphans: string[] = [];
  for (let i = 0; i < candidates.length && orphans.length < limit; i += ORPHAN_CONDEMN_BATCH) {
    const batch = candidates.slice(i, i + ORPHAN_CONDEMN_BATCH);
    const judged = dryRun ? await scope.rowless(batch) : await scope.condemn(batch, opts.now);
    // The scope may only ever answer with ids it was asked about.
    const asked = new Set(batch);
    for (const id of judged) if (asked.has(id)) orphans.push(id);
  }
  report.orphans = orphans.length;
  const doomed = orphans.slice(0, limit);
  if (dryRun) {
    report.keys = doomed.map((id) => attachmentBlobKey(scopeId, id));
    return report;
  }
  if (doomed.length === 0) return report;
  // Guard 3 again, after the condemnation: a rewind that armed mid-pass wrote its fence first.
  if (await fenced()) return report;
  for (const id of doomed) {
    const key = attachmentBlobKey(scopeId, id);
    await store.delete(key);
    report.keys.push(key);
    report.deleted++;
  }
  return report;
}
