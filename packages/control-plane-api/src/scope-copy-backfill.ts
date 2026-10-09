import type { AdminAction, AdminLogEntry, ScopeId, TenantId } from '@substrat-run/contracts';
import type { HostAdmin } from '@substrat-run/kernel';
import { hasCarriedAwayTombstone, listAllScopeScriptCopies, routeOfScope, type ScopeCopyCleanup } from './scope-copy-cleanup.js';

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

type Candidate = { scriptRef: string } | { failure: string };
type Version = Awaited<ReturnType<HostAdmin['getVersion']>>;

const ACTIONS: AdminAction[] = ['bindScopeVersion', 'setScopeServingRef'];
const REFUSED = {
  missing: 'the scope has no directory row; its copy has no ledger anchor',
  reaping: 'the scope is being reaped; the reap does not reach this copy',
} as const;

const objectOf = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const stringOf = (v: unknown): string | null => typeof v === 'string' && v.length > 0 ? v : null;

/** Every script one row names, or the failure that keeps it from naming one. */
async function candidatesOf(row: AdminLogEntry, versionOf: (id: string, vertical: string) => Promise<Version>): Promise<Candidate[]> {
  const before = objectOf(row.before);
  const after = objectOf(row.after);
  if (row.action === 'setScopeServingRef') {
    return [stringOf(before?.servingRef), stringOf(after?.servingRef)]
      .filter((ref): ref is string => ref !== null)
      .map((scriptRef) => ({ scriptRef }));
  }
  const vertical = stringOf(after?.vertical) ?? row.vertical;
  const versionId = stringOf(after?.versionId);
  if (!versionId || !vertical) return [{ failure: 'the bind row names no version or vertical' }];
  const out: Candidate[] = [];
  for (const id of [versionId, stringOf(before?.versionId)].filter((v): v is string => v !== null)) {
    const v = await versionOf(id, vertical);
    if (!v) out.push({ failure: `version ${id} of '${vertical}' is not in the registry` });
    else if (!v.deploymentRef) out.push({ failure: `version ${id} of '${vertical}' names no deployment script` });
    else out.push({ scriptRef: v.deploymentRef });
  }
  return out;
}

export async function backfillScopeScriptCopies(
  input: ScopeCopyCleanup,
  opts: { dryRun: boolean; cursor?: string; limit?: number },
): Promise<CopyBackfillPage> {
  const { admin, actor } = input;
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), BACKFILL_PAGE_MAX);
  const rows = await admin.auditLog(actor, { action: ACTIONS, order: 'asc', limit, ...(opts.cursor ? { cursor: opts.cursor } : {}) });
  // Read once per page: rows of one scope, and of one version, repeat, and nothing here moves them.
  const versions = new Map<string, Promise<Version>>();
  const versionOf = (id: string, vertical: string) => {
    const key = `${vertical}/${id}`;
    if (!versions.has(key)) versions.set(key, admin.getVersion(actor, id, vertical));
    return versions.get(key)!;
  };
  const scopes = new Map<string, { route: string | null; known: Set<string> } | null>();
  const scopeOf = async (tenantId: TenantId, scopeId: ScopeId) => {
    const key = `${tenantId}/${scopeId}`;
    if (!scopes.has(key)) {
      const scope = await admin.getScopeRecord(actor, tenantId, scopeId);
      scopes.set(key, scope ? {
        route: await routeOfScope(input, scope, (id, vertical) => versionOf(id, vertical)),
        known: new Set((await listAllScopeScriptCopies(admin, actor, tenantId, scopeId)).map((copy) => copy.scriptRef)),
      } : null);
    }
    return scopes.get(key)!;
  };
  const entries: CopyBackfillEntry[] = [];
  const historic = new Map<string, { tenantId: TenantId; scopeId: ScopeId }>();
  for (const row of rows) {
    const tenantId = row.tenantId as TenantId | null;
    const scopeId = row.scopeId as ScopeId | null;
    for (const c of await candidatesOf(row, versionOf)) {
      const scriptRef = 'scriptRef' in c ? c.scriptRef : null;
      const base = { fromLogId: row.id, tenantId, scopeId, scriptRef };
      const failure = (reason: string) => entries.push({ ...base, outcome: 'failure', reason });
      if ('failure' in c) { failure(c.failure); continue; }
      if (!tenantId || !scopeId) { failure('the row names no tenant or scope'); continue; }
      const scope = await scopeOf(tenantId, scopeId);
      if (!scope) { failure(REFUSED.missing); continue; }
      if (scope.route === c.scriptRef) { entries.push({ ...base, outcome: 'route' }); continue; }
      if (scope.known.has(c.scriptRef)) { entries.push({ ...base, outcome: 'ledgered' }); continue; }
      // The tombstone is the only thing that lets a script off: anything else, an unreachable
      // script or a failed read included, is recorded and so stays reachable by reap and erasure.
      let reason: string | undefined;
      const holder = await input.resolveRef(c.scriptRef).catch(() => undefined);
      if (!holder) reason = 'no deployment resolves for this script; recorded unchecked';
      else {
        try {
          if (await hasCarriedAwayTombstone(holder, scopeId)) {
            scope.known.add(c.scriptRef); // a later row naming it is answered from here
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
        if (result === 'reaping' || result === 'missing') { failure(REFUSED[result]); continue; }
        outcome = result;
      }
      scope.known.add(c.scriptRef);
      historic.set(`${tenantId}/${scopeId}`, { tenantId, scopeId });
      entries.push({ ...base, outcome, ...(reason ? { reason } : {}) });
    }
  }
  const erased = await Promise.all([...historic.values()].map(async (s) =>
    (await admin.auditLog(actor, { tenantId: s.tenantId, scopeId: s.scopeId, action: 'shredSubject', limit: 1 })).length > 0));
  const failures = entries.filter((entry) => entry.outcome === 'failure');
  if (!opts.dryRun) {
    await Promise.all(failures.map((e) => admin.recordOpsFailure({
      actor,
      operation: 'scope.copy-backfill',
      stage: 'unresolved',
      tenantId: e.tenantId as TenantId | null,
      scopeId: e.scopeId as ScopeId | null,
      message: `admin-log row ${e.fromLogId}${e.scriptRef ? ` (script '${e.scriptRef}')` : ''}: ${e.reason} — ` +
        'a copy this names is not in the copy ledger, so reap and erasure do not reach it (#1722)',
    })));
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
    erasedBefore: [...historic.values()].filter((_, i) => erased[i]),
  };
}
