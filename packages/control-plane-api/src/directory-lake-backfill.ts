import type { PlatformActorId } from '@substrat-run/contracts';
import type { DirectoryLakeDataset, DirectoryLakeSink, HostAdmin } from '@substrat-run/kernel';

/**
 * K-70 (tenants × time data leaves the objects): the backfill of the rows a directory data set
 * held before its capture was switched on. One page per call, read by rowid after `after`; the
 * caller follows `next` until `done` (`scripts/directory-lake-backfill.mjs`).
 *
 * - **A dry run unless asked.** A dry run reads the page and reports what a real run would ship
 *   (count and time span) and whether the data set captures; it ships and marks nothing.
 * - **Shipped straight to the sink, never queued.** Two directory writes a row for a table's
 *   whole history would buy nothing the page does not already have.
 * - **Only for a capturing data set**, on a real run: a row written after the walk passes it
 *   reaches the lake only through the outbox, so a backfill of a data set not capturing would
 *   leave a hole while its mark said there was none.
 * - **Recorded page by page, without a gap.** Each shipped page is recorded in the directory
 *   (`advanceDirectoryLakeBackfill`, one `backfillDirectoryLake` admin row), and a real page must
 *   start where the last recorded one ended, so the page that reaches the table's end records a
 *   `backfilledAt` a later prune may rely on. A dry run may start anywhere.
 * - **Idempotent.** Re-running a page re-ships the same rows; the lake keeps a key's latest
 *   version, and a duplicate is the same version.
 */
export const DIRECTORY_LAKE_BACKFILL_PAGE_MAX = 1_000;

export interface DirectoryLakeBackfillInput {
  dataset: DirectoryLakeDataset;
  dryRun: boolean;
  after: number;
  limit: number;
}

export interface DirectoryLakeBackfillAnswer {
  dataset: DirectoryLakeDataset;
  dryRun: boolean;
  capturing: boolean;
  rows: number;
  /** The span of the rows' own times on this page, or null when it was empty. */
  from: string | null;
  to: string | null;
  next: number | null;
  done: boolean;
  /** Where a real run's page landed; null on a dry run or an empty page. */
  ref: string | null;
  /** The source rowid the next real page must start after, as the directory records it. */
  resumeAfter: number;
  /** When the data set's backfill reached the end, as recorded; null until it has. */
  backfilledAt: string | null;
}

/** Why a real run cannot proceed: the host or the deployment lacks a part, or capture is off. */
export class DirectoryLakeBackfillRefused extends Error {
  constructor(readonly reason: 'unsupported' | 'no-sink' | 'not-capturing' | 'out-of-order', message: string) {
    super(message);
    this.name = 'DirectoryLakeBackfillRefused';
  }
}

export async function backfillDirectoryLake(
  deps: { admin: HostAdmin; actor: PlatformActorId; sink: DirectoryLakeSink | undefined },
  input: DirectoryLakeBackfillInput,
): Promise<DirectoryLakeBackfillAnswer> {
  const { admin, actor, sink } = deps;
  if (!admin.directoryLakeBackfill || !admin.directoryLakeCapture || !admin.advanceDirectoryLakeBackfill) {
    throw new DirectoryLakeBackfillRefused('unsupported', 'this host has no directory outbox to the lake');
  }
  const held = (await admin.directoryLakeCapture(actor)).find((c) => c.dataset === input.dataset);
  if (!input.dryRun) {
    if (!sink) throw new DirectoryLakeBackfillRefused('no-sink', 'this deployment binds no directory lake stream');
    if (!held) {
      throw new DirectoryLakeBackfillRefused('not-capturing', `${input.dataset} is not capturing; switch its capture on before a real backfill`);
    }
  }
  const page = await admin.directoryLakeBackfill(actor, input.dataset, input.after, input.limit);
  const answer: DirectoryLakeBackfillAnswer = {
    dataset: input.dataset,
    dryRun: input.dryRun,
    capturing: held !== undefined,
    rows: page.rows.length,
    from: page.rows[0]?.at ?? null,
    to: page.rows[page.rows.length - 1]?.at ?? null,
    next: page.next,
    done: page.done,
    ref: null,
    resumeAfter: held?.backfillAfter ?? 0,
    backfilledAt: held?.backfilledAt ?? null,
  };
  if (input.dryRun) return answer;
  if (held!.backfilledAt === null && input.after !== held!.backfillAfter) {
    // Checked before shipping, so a page from the wrong place is not sent at all. The directory
    // checks it again when it records the page, which is the check that counts.
    throw new DirectoryLakeBackfillRefused('out-of-order', `the ${input.dataset} backfill resumes after rowid ${held!.backfillAfter}, not ${input.after}`);
  }
  if (page.rows.length > 0) answer.ref = (await sink!.ship(page.rows)).ref;
  const state = await admin.advanceDirectoryLakeBackfill(actor, input.dataset, { after: input.after, next: page.next, done: page.done });
  answer.resumeAfter = state.backfillAfter;
  answer.backfilledAt = state.backfilledAt;
  return answer;
}
