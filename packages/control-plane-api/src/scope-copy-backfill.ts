import type { AdminLogEntry, PlatformActorId, ScopeId, TenantId } from '@substrat-run/contracts';
import type { HostAdmin } from '@substrat-run/kernel';
import { carriedAway, listAllScopeScriptCopies, routeOf, type ScopeCopyCleanup } from './scope-copy-cleanup.js';

/**
 * The backfill of copies made before the directory's copy ledger existed (#1722).
 *
 * A copy move records both its scripts in the ledger before it writes, so reap and erasure reach
 * every copy made since. A scope's data was copied between per-version and serving scripts before
 * that, and those copies are still unknown to both. The admin log is never swept, and it names
 * every script a scope was routed to: a `bindScopeVersion` row names the version (and a promote's
 * row the version before it), whose registry row names its script, and a `setScopeServingRef` row
 * names the serving script before and after. This walks those rows, oldest first, one page per
 * call, and records each script the ledger does not know yet as `retained`.
 *
 * - **Never a guess.** A row naming no version, a version the registry no longer holds, or a scope
 *   whose directory row is gone is a failure: reported, and on a real run written as an ops record
 *   (`scope.copy-backfill`), never marked clean. A re-run reports it again.
 * - **Never a wipe.** `retained` is reached by reap and erasure and is never swept. A historic copy
 *   has no recorded load stamp for a fenced wipe to compare, and a rollback bind may route straight
 *   back onto it, so nothing here decides it is superseded. The only store read is the scope's
 *   `_substrat_meta`, for the tombstone that proves an earlier wipe ran.
 * - **Idempotent and resumable.** `backfillScopeScriptCopy` writes nothing for a script the ledger
 *   already names for the scope; `nextCursor` is the last row read, so a crashed run repeats a page.
 * - **No race with a live move.** The entry is never pending, so no move's confirmation and no lease
 *   sweep acts on it; a reap claim refuses it, and an erasure that read the inventory first refuses
 *   to finalize on the changed count and is retried.
 *
 * `dryRun` walks the same rows and writes nothing.
 */

export const BACKFILL_ACTIONS = ['bindScopeVersion', 'setScopeServingRef'] as const;
export const BACKFILL_PAGE_MAX = 200;

export type CopyBackfillOutcome =
  /** Dry run: would be recorded as retained. */
  | 'would-record'
  | 'recorded'
  /** The ledger already names this script for the scope. */
  | 'ledgered'
  /** The scope routes to this script now: the route reaches it. */
  | 'route'
  /** The store holds a wipe's tombstone: nothing of the scope is left there. */
  | 'wiped'
  | 'failure';

export interface CopyBackfillEntry {
  /** The admin-log row the script was read from. */
  fromLogId: string;
  tenantId: string | null;
  scopeId: string | null;
  scriptRef: string | null;
  outcome: CopyBackfillOutcome;
  /** Why a failure is one, or what a recorded entry could not check (an unreachable script). */
  reason?: string;
}

export interface CopyBackfillPage {
  dryRun: boolean;
  /** The last row read: pass it back as `cursor` to go on, now or after more rows are logged. */
  nextCursor: string | null;
  /** The page came back short: the log has no more rows after `nextCursor` yet. */
  done: boolean;
  rowsRead: number;
  entries: CopyBackfillEntry[];
  counts: Record<CopyBackfillOutcome, number>;
  /**
   * Scopes on this page that took a subject erasure (`shredSubject`) and have a historic copy
   * the ledger did not know: that erasure never reached the copy, so it must be run again once
   * the copy is ledgered. Reported, never run from here.
   */
  erasedBefore: { tenantId: string; scopeId: string }[];
}

interface Candidate {
  row: AdminLogEntry;
  scriptRef?: string;
  failure?: string;
}

const objectOf = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const stringOf = (v: unknown): string | null => typeof v === 'string' && v.length > 0 ? v : null;

/** Every script one row names, or the failure that keeps it from naming one. */
async function candidatesOf(admin: HostAdmin, actor: PlatformActorId, row: AdminLogEntry): Promise<Candidate[]> {
  const before = objectOf(row.before);
  const after = objectOf(row.after);
  if (row.action === 'setScopeServingRef') {
    return [stringOf(before?.servingRef), stringOf(after?.servingRef)]
      .filter((ref): ref is string => ref !== null)
      .map((scriptRef) => ({ row, scriptRef }));
  }
  const vertical = stringOf(after?.vertical) ?? row.vertical;
  const versionId = stringOf(after?.versionId);
  if (!versionId || !vertical) return [{ row, failure: 'the bind row names no version or vertical' }];
  const versionIds = [versionId, stringOf(before?.versionId)].filter((id): id is string => id !== null);
  const out: Candidate[] = [];
  for (const id of versionIds) {
    const v = await admin.getVersion(actor, id, vertical);
    if (!v) out.push({ row, failure: `version ${id} of '${vertical}' is not in the registry` });
    else if (!v.deploymentRef) out.push({ row, failure: `version ${id} of '${vertical}' names no deployment script` });
    else out.push({ row, scriptRef: v.deploymentRef });
  }
  return out;
}

export async function backfillScopeScriptCopies(
  input: ScopeCopyCleanup,
  opts: { dryRun: boolean; cursor?: string; limit?: number },
): Promise<CopyBackfillPage> {
  const { admin, actor } = input;
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), BACKFILL_PAGE_MAX);
  const rows = await admin.auditLog(actor, {
    action: [...BACKFILL_ACTIONS], order: 'asc', limit, ...(opts.cursor ? { cursor: opts.cursor } : {}),
  });
  const entries: CopyBackfillEntry[] = [];
  const ledgered = new Map<string, Set<string>>();
  const historic = new Map<string, { tenantId: TenantId; scopeId: ScopeId }>();
  for (const row of rows) {
    for (const c of await candidatesOf(admin, actor, row)) {
      const tenantId = row.tenantId as TenantId | null;
      const scopeId = row.scopeId as ScopeId | null;
      const base = { fromLogId: row.id, tenantId, scopeId, scriptRef: c.scriptRef ?? null };
      if (c.failure || !c.scriptRef || !tenantId || !scopeId) {
        entries.push({ ...base, outcome: 'failure', reason: c.failure ?? 'the row names no tenant or scope' });
        continue;
      }
      const scope = await admin.getScopeRecord(actor, tenantId, scopeId);
      if (!scope) {
        entries.push({ ...base, outcome: 'failure', reason: 'the scope has no directory row; its copy has no ledger anchor' });
        continue;
      }
      if (await routeOf(input, tenantId, scopeId) === c.scriptRef) {
        entries.push({ ...base, outcome: 'route' });
        continue;
      }
      const key = `${tenantId}/${scopeId}`;
      let known = ledgered.get(key);
      if (!known) {
        known = new Set((await listAllScopeScriptCopies(admin, actor, tenantId, scopeId)).map((copy) => copy.scriptRef));
        ledgered.set(key, known);
      }
      if (known.has(c.scriptRef)) {
        entries.push({ ...base, outcome: 'ledgered' });
        continue;
      }
      // The tombstone is the only thing that lets a script off: anything else, an unreachable
      // script or a failed read included, is recorded and so stays reachable by reap and erasure.
      let reason: string | undefined;
      const holder = await input.resolveRef(c.scriptRef).catch(() => undefined);
      if (!holder) reason = 'no deployment resolves for this script; recorded unchecked';
      else {
        try {
          if (await carriedAway(holder, scopeId)) {
            entries.push({ ...base, outcome: 'wiped' });
            continue;
          }
        } catch (e) {
          reason = `the store could not be read (${e instanceof Error ? e.message : String(e)}); recorded unchecked`;
        }
      }
      let outcome: CopyBackfillOutcome = 'would-record';
      if (!opts.dryRun) {
        const result = await admin.backfillScopeScriptCopy(actor, tenantId, scopeId, c.scriptRef);
        if (result === 'reaping' || result === 'missing') {
          entries.push({ ...base, outcome: 'failure',
            reason: result === 'reaping' ? 'the scope is being reaped; the reap does not reach this copy' : 'the scope has no directory row' });
          continue;
        }
        outcome = result;
      }
      known.add(c.scriptRef);
      historic.set(key, { tenantId, scopeId });
      entries.push({ ...base, outcome, ...(reason ? { reason } : {}) });
    }
  }
  const erasedBefore: CopyBackfillPage['erasedBefore'] = [];
  for (const s of historic.values()) {
    if ((await admin.auditLog(actor, { tenantId: s.tenantId, scopeId: s.scopeId, action: 'shredSubject', limit: 1 })).length) {
      erasedBefore.push(s);
    }
  }
  if (!opts.dryRun) {
    for (const e of entries.filter((entry) => entry.outcome === 'failure')) {
      await admin.recordOpsFailure({
        actor,
        operation: 'scope.copy-backfill',
        stage: 'unresolved',
        tenantId: e.tenantId as TenantId | null,
        scopeId: e.scopeId as ScopeId | null,
        message: `admin-log row ${e.fromLogId}${e.scriptRef ? ` (script '${e.scriptRef}')` : ''}: ${e.reason} — ` +
          'a copy this names is not in the copy ledger, so reap and erasure do not reach it (#1722)',
      });
    }
  }
  const counts = { 'would-record': 0, recorded: 0, ledgered: 0, route: 0, wiped: 0, failure: 0 };
  for (const e of entries) counts[e.outcome]++;
  return {
    dryRun: opts.dryRun,
    nextCursor: rows.at(-1)?.id ?? opts.cursor ?? null,
    done: rows.length < limit,
    rowsRead: rows.length,
    entries,
    counts,
    erasedBefore,
  };
}
