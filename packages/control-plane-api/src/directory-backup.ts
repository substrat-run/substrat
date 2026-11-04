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

import type { DirectoryBackup, PlatformActorId } from '@substrat-run/contracts';
import type { HostAdmin } from '@substrat-run/kernel';
import type { DirectoryBackupStore } from './backups.js';

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
  /** Injected clock, for tests. */
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
  const now = options.now?.() ?? new Date();
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
  // A copy started since the newest one finished either failed or is still being read. Either
  // way the next waits it out, so a copy that cannot be taken is tried a few times a day.
  if (!options.force) {
    const attempted = await store.lastAttempt();
    if (attempted && (!newest || attempted > newest.capturedAt) && now.getTime() - new Date(attempted).getTime() < retryMs) {
      return { taken: null, skippedFor: null, waitingOutAttempt: attempted, pruned: 0 };
    }
  }
  // Noted before the first read: a copy that runs the directory out of memory leaves nothing else.
  await store.markAttempt({ attemptedAt: now.toISOString() });

  // A page at a time where the host offers it (#2868): only one page is ever held here. A copy
  // that stops part-way is discarded here; one whose invocation is cut off leaves pages that a
  // later commit sweeps (the store's `commit`).
  let taken: DirectoryBackup;
  if (admin.exportDirectoryPage) {
    let page = await admin.exportDirectoryPage(actor, null);
    const copy = store.begin({ capturedAt: page.capturedAt });
    const tables = new Set<string>();
    let entries = 0;
    try {
      for (;;) {
        await copy.put(entries++, page.tables);
        for (const t of page.tables) tables.add(t.name);
        if (page.next === null) break;
        page = await admin.exportDirectoryPage(actor, page.next);
      }
      taken = await copy.commit({ entries, tables: tables.size });
    } catch (e) {
      await copy.discard().catch(() => undefined);
      throw e;
    }
  } else {
    const dump = await admin.exportDirectory(actor);
    const copy = store.begin({ capturedAt: dump.capturedAt });
    try {
      await copy.put(0, dump.tables);
      taken = await copy.commit({ entries: 1, tables: dump.tables.length });
    } catch (e) {
      await copy.discard().catch(() => undefined);
      throw e;
    }
  }

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
  return { taken, skippedFor: null, waitingOutAttempt: null, pruned };
}
