/**
 * The scheduled directory backup (#40) — the platform's own disaster-recovery pass.
 *
 * `control-plane.md` names the stake without resolving it: *"The directory becomes a real
 * database, with its own migrations and backup story… Losing it is losing the platform,
 * not losing a cache."* Every OTHER database the platform holds is a scope, protected by
 * ~30-day Durable Object point-in-time recovery — which is continuous, per-scope, and
 * strictly better than any daily copy, so scheduled per-scope backups are deliberately not
 * built here. The directory is the one database PITR cannot answer for: it is a single DO,
 * and a control-plane bug that deletes it outright leaves nothing to rewind. So a copy
 * lives OUTSIDE the DO, and this is what takes it.
 *
 * Driven by the same cron that drives the platform sweep, and the cadence is enforced HERE
 * rather than by a second trigger. A quarter-hourly sweep asking "is a copy due?" and answering
 * from the store is idempotent, survives a missed tick (the next pass takes it, late
 * rather than never), and needs no durable "last run" state of its own — the newest stored
 * copy IS that state. A dedicated daily trigger would have to be right about time zones,
 * deploys and restarts to do the same job worse.
 */

import {
  errorCodeOf,
  type DirectoryBackup,
  type DirectoryCopyByReference,
  type DirectoryCopyReferenceCheck,
  type DirectoryDumpPage,
  type PlatformActorId,
} from '@substrat-run/contracts';
import type { HostAdmin } from '@substrat-run/kernel';
import type { DirectoryBackupStore, DirectoryBackupWriter } from './backups.js';

/** One copy a day; the sweep runs far more often and skips in between. */
const DEFAULT_INTERVAL_HOURS = 24;
/**
 * Thirty copies — a month of daily history, matching the DO PITR horizon so the two
 * defences expire together rather than leaving a window covered by neither.
 */
const DEFAULT_RETAIN = 30;
/**
 * Hours a failed copy is waited out before the next is tried (#2868). Without it, a copy that
 * cannot be taken is tried by every pass, and one that fails by running the directory out of
 * memory reset it ninety-six times a day.
 */
const DEFAULT_RETRY_HOURS = 6;

/**
 * How long one scheduled pass reads a copy before it pauses it (#3422). The pass runs other phases
 * before and after the copy, inside a cron invocation's 15 minutes; a copy that needed 834 s of
 * them on 2026-11-24 was killed the next day and left nothing. A paused copy resumes next pass.
 */
export const DIRECTORY_COPY_PASS_BUDGET_MS = 5 * 60_000;

/**
 * Hours a paused copy is resumed for (#3422). Its pages are swept a day after it was captured if no
 * commit names them, so an older pause starts again rather than finishing on swept pages.
 */
const RESUME_HOURS = 12;

export interface DirectoryBackupOptions {
  admin: HostAdmin;
  store: DirectoryBackupStore;
  /** The platform actor the export is audited under. */
  actor: PlatformActorId;
  /** Hours between copies (default 24). */
  intervalHours?: number;
  /** How many copies to keep (default 30). Older ones are deleted after a successful put. */
  retain?: number;
  /** Hours a failed copy is waited out before the next is tried (default 6). `force` does not wait. */
  retryHours?: number;
  /** Take a copy regardless of cadence — what the manual "back up now" route passes. */
  force?: boolean;
  /**
   * How the copy carries the tables the host can read by reference instead of copying them into a
   * snapshot first (#3325): `off` (the default) copies everything, `verify` copies everything and
   * reports what a by-reference copy would have held, `on` reads them by reference. A host without
   * paged export ignores it.
   */
  byReference?: DirectoryCopyByReference;
  /**
   * Milliseconds this call reads pages before it pauses the copy, for the next call to resume
   * (#3422). Unset: the copy is read to its end. The scheduled pass passes
   * `DIRECTORY_COPY_PASS_BUDGET_MS`. A host without paged export ignores it.
   */
  budgetMs?: number;
  /** Injected clock, for tests. Read again for the budget, so a test's clock can move. */
  now?: () => Date;
}

export interface DirectoryBackupResult {
  /** The copy taken this pass, or null when the cadence guard skipped it. */
  taken: DirectoryBackup | null;
  /** When nothing was taken: the copy that was still fresh enough to skip for. */
  skippedFor: string | null;
  /** When nothing was taken because a copy started then has not finished: when it started. */
  waitingOutAttempt: string | null;
  /** Copies deleted by the retention window this pass. */
  pruned: number;
  /** A `verify` copy's comparison of each by-reference table (#3325); absent otherwise. */
  referenceCheck?: DirectoryCopyReferenceCheck[];
  /** #3422: the copy this pass paused at its budget, for the next pass to resume. */
  paused?: { capturedAt: string; entries: number };
  /** #3422: this pass carried on a copy an earlier pass paused. */
  resumed?: true;
  /**
   * #3422: when this pass started a copy, the start of an earlier one that never finished and never
   * said why (its invocation was cut off). A failure nothing else reports, so the caller does.
   */
  unfinishedAttempt?: string;
}

/** A copy part-way through: its writer, the page in hand, and what the pages before it held. */
interface CopyInProgress {
  copy: DirectoryBackupWriter;
  page: DirectoryDumpPage;
  capturedAt: string;
  bookmark?: string;
  byReference: DirectoryCopyByReference;
  entries: number;
  tables: Set<string>;
}

/**
 * Take a directory backup if one is due, then prune to the retention window.
 *
 * Order matters and is the inverse of the reap's (#493). A reap stores BEFORE it wipes,
 * because the wipe is what the copy protects against. Here the prune runs AFTER a
 * successful put, so a failed capture can never be the thing that deletes the last good
 * copy — the worst case is an extra copy kept, never a missing one.
 *
 * Throws whatever the export or the store threw. The caller (a cron pass) decides what a
 * failure means; it must not be silent, which is why nothing is swallowed here.
 */
export async function backupDirectoryIfDue(
  options: DirectoryBackupOptions,
): Promise<DirectoryBackupResult> {
  const clock = (): Date => options.now?.() ?? new Date();
  const now = clock();
  const retain = options.retain ?? DEFAULT_RETAIN;
  const intervalMs = (options.intervalHours ?? DEFAULT_INTERVAL_HOURS) * 3_600_000;
  const retryMs = (options.retryHours ?? DEFAULT_RETRY_HOURS) * 3_600_000;
  const { admin, store, actor } = options;

  // The store IS the schedule's memory: newest copy, newest first (the store sorts).
  const existing = await store.list();
  const newest = existing[0];
  if (!options.force && newest) {
    const age = now.getTime() - new Date(newest.capturedAt).getTime();
    // `age < 0` — a copy stamped in the future, from a clock skew or a hand-uploaded
    // object — counts as fresh. Skipping is the conservative read: taking a copy is
    // cheap, but treating a future timestamp as "infinitely overdue" would take one on
    // every single pass until real time caught up.
    if (age < intervalMs) return { taken: null, skippedFor: newest.capturedAt, waitingOutAttempt: null, pruned: 0 };
  }
  // A copy started since the newest one finished either failed, is still being read, or was paused.
  const attempt = await store.lastAttempt();
  const unfinished = attempt && (!newest || attempt.attemptedAt > newest.capturedAt) ? attempt : null;
  const sinceAttempt = unfinished ? now.getTime() - new Date(unfinished.attemptedAt).getTime() : Infinity;

  let started: CopyInProgress | null = null;
  let resumed = false;
  // #3422: a paused copy is carried on at once, where it stopped. Its snapshot is still in the host.
  const pause = unfinished?.paused;
  if (!options.force && pause && admin.exportDirectoryPage && sinceAttempt < RESUME_HOURS * 3_600_000) {
    // Noted as running again: a pass cut off from here on is waited out, like any other.
    await store.markAttempt({ attemptedAt: now.toISOString() });
    const copy = store.begin({
      capturedAt: pause.capturedAt,
      ...(pause.bookmark ? { bookmark: pause.bookmark } : {}),
      resume: { stageId: pause.stageId, sizes: pause.sizes },
    });
    try {
      const page = await admin.exportDirectoryPage(actor, pause.next);
      started = { copy, page, capturedAt: pause.capturedAt, ...(pause.bookmark ? { bookmark: pause.bookmark } : {}),
        byReference: pause.byReference, entries: pause.sizes.length, tables: new Set(pause.tables) };
      resumed = true;
    } catch (e) {
      // A conflict says the copy is gone (a later copy or a restore replaced it), or that it cannot
      // go on as one copy: its pages are dropped and a new copy starts below. Anything else fails.
      await copy.discard().catch(() => undefined);
      if (errorCodeOf(e) !== 'conflict') return markFailed(e);
    }
  } else if (!options.force && unfinished && !pause && sinceAttempt < retryMs) {
    // Either way the next waits it out, so a copy that cannot be taken is tried a few times a day.
    return { taken: null, skippedFor: null, waitingOutAttempt: unfinished.attemptedAt, pruned: 0 };
  }
  // An earlier copy that never finished and never said why: its pass was cut off (#3422).
  const unreported = !started && unfinished && !unfinished.failed && !unfinished.paused ? unfinished.attemptedAt : undefined;

  if (!started) {
    // Noted before the first read: a copy that runs the directory out of memory leaves nothing else.
    await store.markAttempt({ attemptedAt: now.toISOString() });
    if (!admin.exportDirectoryPage) {
      const taken = await copyWhole(admin, store, actor).catch(markFailed);
      return finish({ taken, unfinishedAttempt: unreported });
    }
    const byReference = options.byReference ?? 'off';
    // A page at a time where the host offers it (#2868): only one page is ever held here. A copy
    // that stops part-way is discarded here; one whose invocation is cut off leaves pages that a
    // later commit sweeps (the store's `commit`).
    const page = await admin.exportDirectoryPage(actor, null, { byReference }).catch(markFailed);
    // The PITR bookmark at the copy's instant (#3325), stored with it so a rewind can name the same point.
    const copy = store.begin({ capturedAt: page.capturedAt, ...(page.bookmark ? { bookmark: page.bookmark } : {}) });
    started = { copy, page, capturedAt: page.capturedAt, ...(page.bookmark ? { bookmark: page.bookmark } : {}),
      byReference, entries: 0, tables: new Set() };
  }

  const { copy, capturedAt, bookmark, byReference, tables } = started;
  let { page, entries } = started;
  const deadline = options.budgetMs === undefined ? Infinity : now.getTime() + options.budgetMs;
  let taken: DirectoryBackup;
  let referenceCheck: DirectoryCopyReferenceCheck[] | undefined;
  try {
    for (;;) {
      await copy.put(entries++, page.tables);
      for (const t of page.tables) tables.add(t.name);
      if (page.next === null) {
        referenceCheck = page.referenceCheck;
        break;
      }
      if (clock().getTime() >= deadline) {
        // #3422: out of budget. The pages and the host's snapshot stay; the next pass resumes here.
        await store.markAttempt({
          attemptedAt: clock().toISOString(),
          paused: { capturedAt, ...(bookmark ? { bookmark } : {}), byReference, ...copy.stage(), next: page.next, tables: [...tables] },
        });
        return { taken: null, skippedFor: null, waitingOutAttempt: null, pruned: 0,
          paused: { capturedAt, entries }, ...(resumed ? { resumed: true as const } : {}),
          ...(unreported ? { unfinishedAttempt: unreported } : {}) };
      }
      page = await admin.exportDirectoryPage!(actor, page.next);
    }
    taken = await copy.commit({ entries, tables: tables.size });
  } catch (e) {
    await copy.discard().catch(() => undefined);
    return markFailed(e);
  }
  return finish({ taken, referenceCheck, resumed, unfinishedAttempt: unreported });

  /** A copy that throws is reported by the caller it throws to, so the next copy does not report it again as cut off. */
  async function markFailed(e: unknown): Promise<never> {
    await store.markAttempt({ attemptedAt: now.toISOString(), failed: true }).catch(() => undefined);
    throw e;
  }

  async function finish(done: {
    taken: DirectoryBackup;
    referenceCheck?: DirectoryCopyReferenceCheck[];
    resumed?: boolean;
    unfinishedAttempt?: string;
  }): Promise<DirectoryBackupResult> {
    // Prune from a re-read list, not from `existing`: the copy just written has to be in
    // the reckoning, or a retention window of N would keep N+1 forever.
    let pruned = 0;
    if (retain > 0) {
      const all = await store.list();
      for (const stale of all.slice(retain)) {
        await store.delete({ capturedAt: stale.capturedAt });
        pruned += 1;
      }
    }
    return {
      taken: done.taken, skippedFor: null, waitingOutAttempt: null, pruned,
      ...(done.referenceCheck ? { referenceCheck: done.referenceCheck } : {}),
      ...(done.resumed ? { resumed: true as const } : {}),
      ...(done.unfinishedAttempt ? { unfinishedAttempt: done.unfinishedAttempt } : {}),
    };
  }
}

/** A host with no paged export: the whole dump, stored as one page. */
async function copyWhole(admin: HostAdmin, store: DirectoryBackupStore, actor: PlatformActorId): Promise<DirectoryBackup> {
  const dump = await admin.exportDirectory(actor);
  const copy = store.begin({ capturedAt: dump.capturedAt });
  try {
    await copy.put(0, dump.tables);
    return await copy.commit({ entries: 1, tables: dump.tables.length });
  } catch (e) {
    await copy.discard().catch(() => undefined);
    throw e;
  }
}

/**
 * The `DIRECTORY_BACKUP_BY_REFERENCE` setting (#3325): `off`, `verify` or `on`, unset meaning `off`.
 * Anything else is refused as `off` with a reason, so a typo never cuts a copy over unasked.
 */
export function parseDirectoryCopyByReference(raw: string | undefined): {
  mode: DirectoryCopyByReference;
  invalid?: string;
} {
  const value = raw?.trim().toLowerCase() ?? '';
  if (value === '' || value === 'off') return { mode: 'off' };
  if (value === 'verify' || value === 'on') return { mode: value };
  return { mode: 'off', invalid: `DIRECTORY_BACKUP_BY_REFERENCE is ${JSON.stringify(raw)}; expected off, verify or on` };
}

/**
 * The tables of a `verify` copy where a by-reference copy would have differed from the snapshot,
 * when the table is append-only (#3325): any difference there is a fault in that claim, and the
 * switch must not be turned on until it is explained. A `log` table's differences are expected.
 */
export function referenceFaults(checks: readonly DirectoryCopyReferenceCheck[] | undefined): DirectoryCopyReferenceCheck[] {
  return (checks ?? []).filter(
    (c) => c.kind === 'append-only' && (c.ddlChanged || c.missing > 0 || c.changed > 0 || c.extra > 0),
  );
}
