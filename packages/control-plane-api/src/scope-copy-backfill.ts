import type { AdminAction, AdminLogEntry, ChannelHistoryEntry, PlatformActorId, ScopeId, TenantId } from '@substrat-run/contracts';
import { BACKFILL_MOVE_ID, type HostAdmin } from '@substrat-run/kernel';
import { hasCarriedAwayTombstone, listAllScopeScriptCopies, routeOfScope, type ScopeCopyCleanup } from './scope-copy-cleanup.js';

/**
 * The backfill of copies made before the directory's copy ledger existed (#1722).
 *
 * A copy move records both its scripts in the ledger before it writes, so reap and erasure reach
 * every copy made since. A scope's data lived in other scripts before that, and nothing names
 * those copies to reap or erasure. The admin log is never swept, so a scope's own rows say where
 * it was routed, and so where its store was. This walks the log, oldest first, one page per
 * call, and records each such script the ledger does not know yet as `retained`.
 *
 * **Where a scope's data lived** is derived from the scope's whole timeline, never from one row:
 * - **A pin.** Each `setScopeServingRef` row names the serving script before and after; while
 *   pinned, the scope's route was that script. The pin at birth is the first such row's `before`,
 *   or the directory's current pin when the scope has none. An unpin routes the scope to what it
 *   falls back on, the version bound then (or its slug, never bound), which is a home too.
 * - **A bind while unpinned.** A `bindScopeVersion` row names a version (and a promote's row the
 *   version before it), whose registry row names its script. It is a home only while the scope was
 *   not pinned: a pinned scope's bind (a private vertical's promote moves the pointer of every
 *   served install) routes nothing there, and its script never held the scope's store.
 * - **Birth by slug.** A non-preview scope born unpinned was provisioned through its vertical's
 *   slug, into the script of the version on `prod` at that instant (`listChannelHistory`), and no
 *   later row names that script unless a bind happens to. A preview is born by its own bind.
 * - **A fork** is born into the script its source was routed to at that instant, derived the same
 *   way from the source's timeline (the source's slug resolves to its vertical's serving script
 *   when that vertical served in place then).
 *
 * What cannot be derived is a **failure**: reported in every response, written as an ops record on
 * a real run (`scope.copy-backfill`), never marked clean, and reported again on a re-run. That is a
 * row naming no version, a version the registry no longer holds or that names no script, a scope
 * or fork source whose directory row is gone, a scope with no `provisionScope` row, a slug with no
 * `prod` version at the time, a script no deployment answers for, and a store that cannot be read.
 *
 * - **Never a wipe, never a phantom.** `retained` is reached by reap and erasure and is never swept.
 *   A real run reads one thing, the derived home's `_substrat_meta`, for the tombstone that proves
 *   an earlier wipe ran. A dry run touches no store at all: it resolves each script's deployment and
 *   reports what a real run would check.
 * - **Taken over by the ledger.** Once a move's own entry for the same script settles `done`, the
 *   backfilled entry settles with it (`COPY_BACKFILL_SUPERSEDE_SQL`).
 * - **Idempotent and resumable.** `backfillScopeScriptCopy` writes nothing for a script the ledger
 *   already names for the scope; `nextCursor` is the last row read. Admin-log ids are minted before
 *   their row is written, so a row in flight while a page is read can sort below the cursor and be
 *   skipped. That is harmless here: the rows this exists for were written before the ledger existed.
 * - **No race with a live move.** The entry is never pending, so no move's confirmation and no lease
 *   sweep acts on it; a reap claim refuses it, and an erasure that read the inventory first refuses
 *   to finalize on the changed count and is retried.
 * - **Erasures that came first.** Each recorded entry is audited as `backfillScopeCopy`. A subject
 *   whose last erasure in that scope is older than the scope's last backfill row never reached the
 *   recorded copy; every run reports those scopes and subjects, and a real run writes an ops record
 *   for each (`erased-before`). Erasing them again is the operator's call.
 */

export const BACKFILL_PAGE_MAX = 200;

export type CopyBackfillOutcome =
  /** Dry run: a derived home whose deployment resolves; a real run checks its store, then records it. */
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
  /** The admin-log row the script was derived from. */
  fromLogId: string;
  tenantId: string | null;
  scopeId: string | null;
  scriptRef: string | null;
  outcome: CopyBackfillOutcome;
  /** Why a failure is one. */
  reason?: string;
}

export interface CopyBackfillPage {
  dryRun: boolean;
  /** The last row read: pass it back as `cursor` to go on. */
  nextCursor: string | null;
  /** The page came back short: the log has no more rows after `nextCursor`. */
  done: boolean;
  rowsRead: number;
  entries: CopyBackfillEntry[];
  counts: Record<CopyBackfillOutcome, number>;
  /**
   * Scopes on this page with a backfilled copy and subjects erased there before it was recorded:
   * those erasures never reached it, so each subject must be erased again. Reported, never run.
   */
  erasedBefore: { tenantId: string; scopeId: string; subjects: string[] }[];
}

type Candidate = { scriptRef: string } | { failure: string };
type Version = Awaited<ReturnType<HostAdmin['getVersion']>>;

const TIMELINE: AdminAction[] = ['provisionScope', 'bindScopeVersion', 'setScopeServingRef'];

const objectOf = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const stringOf = (v: unknown): string | null => typeof v === 'string' && v.length > 0 ? v : null;

/** Every row an admin-log filter matches, oldest first. */
async function allRows(admin: HostAdmin, actor: PlatformActorId, filter: Parameters<HostAdmin['auditLog']>[1]): Promise<AdminLogEntry[]> {
  const out: AdminLogEntry[] = [];
  for (;;) {
    const page = await admin.auditLog(actor, { ...filter, order: 'asc', limit: BACKFILL_PAGE_MAX,
      ...(out.length ? { cursor: out[out.length - 1]!.id } : {}) });
    out.push(...page);
    if (page.length < BACKFILL_PAGE_MAX) return out;
  }
}

/** One scope's own rows and directory state: what every derivation for it reads. */
interface Timeline {
  tenantId: TenantId;
  scopeId: ScopeId;
  /** The directory row now, absent once the scope was deleted. */
  exists: boolean;
  servingRefNow: string | null;
  route: string | null;
  rows: AdminLogEntry[];
  provision: AdminLogEntry | undefined;
  /** Scripts the ledger names for the scope, and those the backfill recorded that are still open. */
  known: Set<string>;
  backfilled: Set<string>;
}

/**
 * The scope's pin just before log row `id`: a script, null when unpinned, undefined when nothing
 * says (a deleted scope that never moved its pin: its birth pin was on the row that is gone).
 */
function pinnedBefore(tl: Timeline, id: string): string | null | undefined {
  const serving = tl.rows.filter((r) => r.action === 'setScopeServingRef');
  const last = serving.filter((r) => r.id < id).at(-1);
  if (last) return stringOf(objectOf(last.after)?.servingRef);
  if (serving.length) return stringOf(objectOf(serving[0]!.before)?.servingRef);
  return tl.exists ? tl.servingRefNow : undefined;
}

class Deriver {
  private readonly versions = new Map<string, Promise<Version>>();
  private readonly timelines = new Map<string, Promise<Timeline>>();
  private readonly prodHistory = new Map<string, Promise<ChannelHistoryEntry[]>>();
  private servingHistory: Promise<AdminLogEntry[]> | undefined;

  constructor(private readonly input: ScopeCopyCleanup) {}

  versionOf(id: string, vertical: string): Promise<Version> {
    const key = `${vertical}/${id}`;
    if (!this.versions.has(key)) this.versions.set(key, this.input.admin.getVersion(this.input.actor, id, vertical));
    return this.versions.get(key)!;
  }

  timeline(tenantId: TenantId, scopeId: ScopeId): Promise<Timeline> {
    const key = `${tenantId}/${scopeId}`;
    if (!this.timelines.has(key)) this.timelines.set(key, this.load(tenantId, scopeId));
    return this.timelines.get(key)!;
  }

  private async load(tenantId: TenantId, scopeId: ScopeId): Promise<Timeline> {
    const { admin, actor } = this.input;
    const [scope, rows, copies] = await Promise.all([
      admin.getScopeRecord(actor, tenantId, scopeId),
      allRows(admin, actor, { tenantId, scopeId, action: TIMELINE }),
      listAllScopeScriptCopies(admin, actor, tenantId, scopeId),
    ]);
    return {
      tenantId, scopeId,
      exists: Boolean(scope),
      servingRefNow: scope?.servingRef ?? null,
      route: scope ? await routeOfScope(this.input, scope, (id, vertical) => this.versionOf(id, vertical)) : null,
      rows,
      provision: rows.find((r) => r.action === 'provisionScope'),
      known: new Set(copies.map((c) => c.scriptRef)),
      backfilled: new Set(copies.filter((c) => c.moveId === BACKFILL_MOVE_ID && c.state !== 'done').map((c) => c.scriptRef)),
    };
  }

  /** A version's script, or why it has none. */
  async scriptOf(id: string, vertical: string): Promise<Candidate> {
    const v = await this.versionOf(id, vertical);
    if (!v) return { failure: `version ${id} of '${vertical}' is not in the registry` };
    if (!v.deploymentRef) return { failure: `version ${id} of '${vertical}' names no deployment script` };
    return { scriptRef: v.deploymentRef };
  }

  /** Where `vertical`'s slug resolved at `at`: its serving script when it served in place, else prod's. */
  private async slugAt(vertical: string, at: string): Promise<Candidate> {
    const { admin, actor } = this.input;
    this.servingHistory ??= allRows(admin, actor, { action: 'setVerticalServing' });
    // Ordered against another table by time alone, so a change in the same millisecond is ambiguous.
    const ambiguous = { failure: `'${vertical}' changed where its slug resolves in the same millisecond as ${at}` };
    const servingRows = (await this.servingHistory).filter((r) => r.vertical === vertical || objectOf(r.after)?.vertical === vertical);
    if (servingRows.some((r) => r.at === at)) return ambiguous;
    const serving = servingRows.filter((r) => r.at < at).at(-1);
    const servingRef = serving ? stringOf(objectOf(serving.after)?.ref) : null;
    if (servingRef) return { scriptRef: servingRef };
    if (!this.prodHistory.has(vertical)) this.prodHistory.set(vertical, (async () => {
      const out: ChannelHistoryEntry[] = [];
      for (;;) {
        const page = await admin.listChannelHistory(actor, vertical, 'prod',
          { order: 'asc', limit: BACKFILL_PAGE_MAX, ...(out.length ? { cursor: out[out.length - 1]!.id } : {}) });
        out.push(...page);
        if (page.length < BACKFILL_PAGE_MAX) return out;
      }
    })());
    const history = await this.prodHistory.get(vertical)!;
    if (history.some((e) => e.at === at)) return ambiguous;
    const prod = history.filter((e) => e.at < at).at(-1);
    if (!prod) return { failure: `'${vertical}' had no prod version at ${at}, so the script its slug resolved to is not known` };
    return this.scriptOf(prod.versionId, vertical);
  }

  /** The script `tl`'s scope was routed to just before log row `id` was written at `at`. */
  async routeAt(tl: Timeline, id: string, at: string): Promise<Candidate> {
    const pin = pinnedBefore(tl, id);
    if (pin === undefined) return { failure: `scope ${tl.scopeId} is gone and its pin at the time is not in the log` };
    return pin ? { scriptRef: pin } : this.unpinnedRouteAt(tl, id, at);
  }

  /** Where `tl`'s scope routed just before row `id` with no pin: its bound version, else its slug. */
  async unpinnedRouteAt(tl: Timeline, id: string, at: string): Promise<Candidate> {
    const bind = tl.rows.filter((r) => r.action === 'bindScopeVersion' && r.id < id).at(-1);
    if (bind) {
      const after = objectOf(bind.after);
      const versionId = stringOf(after?.versionId);
      const vertical = stringOf(after?.vertical) ?? bind.vertical;
      if (!versionId || !vertical) return { failure: `bind row ${bind.id} names no version or vertical` };
      return this.scriptOf(versionId, vertical);
    }
    const vertical = tl.provision ? stringOf(objectOf(tl.provision.after)?.vertical) ?? tl.provision.vertical : null;
    if (!vertical) return { failure: 'its vertical is not in the log' };
    return this.slugAt(vertical, at);
  }

  /** The script one timeline row names as a home of its scope, or why it cannot be derived. */
  async candidatesOf(tl: Timeline, row: AdminLogEntry): Promise<Candidate[]> {
    const before = objectOf(row.before);
    const after = objectOf(row.after);
    if (row.action === 'setScopeServingRef') {
      const pins = [stringOf(before?.servingRef), stringOf(after?.servingRef)]
        .filter((ref): ref is string => ref !== null)
        .map((scriptRef): Candidate => ({ scriptRef }));
      // An unpin routes the scope to what it falls back on: the version bound then, or its slug.
      return stringOf(after?.servingRef) ? pins : [...pins, await this.unpinnedRouteAt(tl, row.id, row.at)];
    }
    if (row.action === 'bindScopeVersion') {
      // Pinned, the bind moved a pointer and routed nothing: its script never held the store.
      if (pinnedBefore(tl, row.id)) return [];
      const vertical = stringOf(after?.vertical) ?? row.vertical;
      const versionId = stringOf(after?.versionId);
      if (!versionId || !vertical) return [{ failure: 'the bind row names no version or vertical' }];
      const ids = [versionId, stringOf(before?.versionId)].filter((v): v is string => v !== null);
      return Promise.all(ids.map((id) => this.scriptOf(id, vertical)));
    }
    // provisionScope: where the store was born, when no other row names it.
    if (row.id !== tl.provision?.id) return [];
    if (after?.kind === 'preview' || pinnedBefore(tl, row.id)) return []; // born by its bind, or on its pin
    const vertical = stringOf(after?.vertical) ?? row.vertical;
    if (!vertical) return [];
    const forkedFrom = stringOf(after?.forkedFrom);
    if (!forkedFrom) return [await this.slugAt(vertical, row.at)];
    const source = await this.timeline(tl.tenantId, forkedFrom as ScopeId);
    if (!source.exists && !source.rows.length) return [{ failure: `the fork's source ${forkedFrom} is not in the directory or the log` }];
    return [await this.routeAt(source, row.id, row.at)];
  }
}

export async function backfillScopeScriptCopies(
  input: ScopeCopyCleanup,
  opts: { dryRun: boolean; cursor?: string; limit?: number },
): Promise<CopyBackfillPage> {
  const { admin, actor } = input;
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), BACKFILL_PAGE_MAX);
  const rows = await admin.auditLog(actor, { action: TIMELINE, order: 'asc', limit, ...(opts.cursor ? { cursor: opts.cursor } : {}) });
  const derive = new Deriver(input);
  const entries: CopyBackfillEntry[] = [];
  const seen = new Map<string, Timeline>();
  for (const row of rows) {
    const tenantId = row.tenantId as TenantId | null;
    const scopeId = row.scopeId as ScopeId | null;
    const base = { fromLogId: row.id, tenantId, scopeId };
    const failure = (scriptRef: string | null, reason: string) => entries.push({ ...base, scriptRef, outcome: 'failure', reason });
    if (!tenantId || !scopeId) { failure(null, 'the row names no tenant or scope'); continue; }
    const tl = await derive.timeline(tenantId, scopeId);
    seen.set(`${tenantId}/${scopeId}`, tl);
    if (!tl.exists) { failure(null, 'the scope has no directory row; a copy it left has no ledger anchor'); continue; }
    if (!tl.provision) { failure(null, 'the scope has no provisionScope row; the script it was born in is not in the log'); continue; }
    for (const c of await derive.candidatesOf(tl, row)) {
      if ('failure' in c) { failure(null, c.failure); continue; }
      const scriptRef = c.scriptRef;
      const at = { ...base, scriptRef };
      if (tl.route === scriptRef) { entries.push({ ...at, outcome: 'route' }); continue; }
      if (tl.known.has(scriptRef)) { entries.push({ ...at, outcome: 'ledgered' }); continue; }
      const holder = await input.resolveRef(scriptRef).catch(() => undefined);
      if (!holder) { failure(scriptRef, 'no deployment resolves for this script'); continue; }
      if (opts.dryRun) { entries.push({ ...at, outcome: 'would-record' }); continue; }
      try {
        if (await hasCarriedAwayTombstone(holder, scopeId)) {
          tl.known.add(scriptRef); // a later row naming it is answered from here
          entries.push({ ...at, outcome: 'wiped' });
          continue;
        }
      } catch (e) {
        failure(scriptRef, `the store could not be read (${e instanceof Error ? e.message : String(e)})`);
        continue;
      }
      const result = await admin.backfillScopeScriptCopy(actor, tenantId, scopeId, scriptRef, { fromLogId: row.id });
      if (result === 'reaping') { failure(scriptRef, 'the scope is being reaped; the reap does not reach this copy'); continue; }
      if (result === 'missing') { failure(scriptRef, 'the scope has no directory row'); continue; }
      tl.known.add(scriptRef);
      if (result === 'recorded') tl.backfilled.add(scriptRef);
      entries.push({ ...at, outcome: result });
    }
  }
  const erasedBefore = (await Promise.all([...seen.values()].filter((tl) => tl.backfilled.size > 0)
    .map(async (tl) => ({ tenantId: tl.tenantId, scopeId: tl.scopeId, subjects: await erasedBeforeBackfill(admin, actor, tl) }))))
    .filter((s) => s.subjects.length > 0);
  if (!opts.dryRun) {
    await Promise.all([
      ...entries.filter((e) => e.outcome === 'failure').map((e) => admin.recordOpsFailure({
        actor, operation: 'scope.copy-backfill', stage: 'unresolved',
        tenantId: e.tenantId as TenantId | null, scopeId: e.scopeId as ScopeId | null,
        message: `admin-log row ${e.fromLogId}${e.scriptRef ? ` (script '${e.scriptRef}')` : ''}: ${e.reason} — ` +
          'a copy this may name is not in the copy ledger, so reap and erasure do not reach it (#1722)',
      })),
      ...erasedBefore.map((s) => admin.recordOpsFailure({
        actor, operation: 'scope.copy-backfill', stage: 'erased-before',
        tenantId: s.tenantId as TenantId, scopeId: s.scopeId as ScopeId,
        message: `${s.subjects.length} subject(s) erased in scope ${s.scopeId} before its historic copies were ledgered: ` +
          'those erasures never reached the copies, so each must be erased again (#1722)',
      })),
    ]);
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

/**
 * The subjects whose last erasure in the scope is older than its last `backfillScopeCopy` row: none
 * of their erasures reached the copy recorded then. A scope with a backfilled entry and no such row
 * (its audit write failed after the insert) counts every erased subject, which is the safe answer.
 */
async function erasedBeforeBackfill(admin: HostAdmin, actor: PlatformActorId, tl: Timeline): Promise<string[]> {
  const filter = { tenantId: tl.tenantId, scopeId: tl.scopeId };
  const [shreds, [backfill]] = await Promise.all([
    allRows(admin, actor, { ...filter, action: 'shredSubject' }),
    admin.auditLog(actor, { ...filter, action: 'backfillScopeCopy', order: 'desc', limit: 1 }),
  ]);
  const last = new Map<string, string>();
  for (const r of shreds) {
    const subject = stringOf(objectOf(r.after)?.subjectId);
    if (subject) last.set(subject, r.id);
  }
  return [...last].filter(([, id]) => !backfill || id < backfill.id).map(([subject]) => subject).sort();
}
