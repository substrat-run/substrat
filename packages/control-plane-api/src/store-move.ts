import type { ScopeDumpTable } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { ControlPlaneError } from '@substrat-run/control-plane-client';
import type { DeclaredScopeStore } from './platform-scope-stores.js';

/**
 * A store's data moved a page at a time (D-69): out of a store's chain or a backup's page objects,
 * into a stage or a backup's page objects, holding one page. The state is cursors and counts, JSON, so
 * a request can hand it to a job and a job can store it; it never holds a row.
 *
 * Its own stepper, not `transferStep` over `TransferEnds`: that one moves a scope, through a client
 * that names scope ids, a capture to catch up on, a `_substrat_meta` to fold, and a job under a
 * scope-script move's lease. A store has one chain, an opaque revision and a driver's stage, so all
 * that would be stubbed out. The shape is the same: read a page, write it, next; a revision that moved
 * starts again under a new id; nothing changes the object until a commit.
 */
export interface PageMoveEnds {
  read(cursor: string | null): Promise<{ tables: ScopeDumpTable[]; next: string | null; revision: string }>;
  /**
   * `held`: the far end already has this page, from a chain this state cannot vouch for, so it starts
   * again. `pages`: how many places in the far end's sequence this read took, 1 unless it was cut.
   */
  write(moveId: string, seq: number, tables: ScopeDumpTable[]): Promise<{ held: boolean; pages?: number }>;
  /** Best effort: what a dropped move leaves goes with its stage's age, or with retention. */
  discard(moveId: string): Promise<void>;
}

/** A chain in flight. `moveId` names its stage or its page objects; `seq` is the next place to write. */
export interface PageMoveState {
  moveId: string;
  seq: number;
  cursor: string | null;
  revision: string | null;
  attempt: number;
  /** Pages read along this chain. Not `seq`, which a restore's cuts can run past the reads. */
  reads: number;
  /** The distinct tables seen so far: names, what a commit's count is compared with. */
  tableNames: string[];
  rows: number;
}

export const newPageMove = (attempt = 1): PageMoveState => ({
  moveId: ulid(), seq: 0, cursor: null, revision: null, attempt, reads: 0, tableNames: [], rows: 0,
});

/** How many chains a move reads before it refuses, each after a longer wait than the last. */
export const STORE_MOVE_ATTEMPTS = 5;
/** The wait before the chain after attempt `attempt`, ms. */
export const storeMoveBackoffMs = (attempt: number): number => Math.min(60_000, 1_000 * 2 ** (attempt - 1));
/** The most pages one chain may have, as the kernel's reader has it: a longer one does not end. */
export const STORE_MOVE_MAX_PAGES = 100_000;

export interface PageMoveOptions {
  /** Default `STORE_MOVE_ATTEMPTS`. */
  attempts?: number;
  /** A step's budget: checked after each page, so a step always moves at least one. */
  until?: () => boolean;
  /** Someone waits on this step: it moves no further page and answers where it got to. */
  stopped?: () => boolean;
}

/** `PageMoveOptions`, and told of each state of the plan, for whoever gives up what it left. */
export type StorePlanOptions = PageMoveOptions & { track?: (plan: StoreMovePlan) => void };

/** A move finished, or one still to go: after `delayMs` when it was just started over. */
export type PageMoveProgress = { done: PageMoveState } | { state: PageMoveState; delayMs: number };

const isConflict = (e: unknown): boolean => e instanceof ControlPlaneError && e.status === 409;

/**
 * Move pages of one chain until it ends or the budget says to stop. A chain starts again under a new
 * id, the old one discarded, when the revision moved (the pages would be no one moment), when an end
 * answers 409 (a driver refusing a read during writes, or a stage an erase, a wipe or another writer
 * dropped), and, without counting as an attempt, when the far end says it holds the page (`held`).
 * After `attempts` chains it refuses (409), with the object as it was.
 */
export async function movePages(
  ends: PageMoveEnds,
  state: PageMoveState,
  what: string,
  opts: PageMoveOptions = {},
): Promise<PageMoveProgress> {
  let next = state;
  const restart = async (counted: boolean): Promise<PageMoveProgress> => {
    await ends.discard(next.moveId).catch(() => undefined);
    if (!counted) return { state: newPageMove(next.attempt), delayMs: 0 };
    const attempts = opts.attempts ?? STORE_MOVE_ATTEMPTS;
    if (next.attempt >= attempts) {
      throw new ControlPlaneError(
        409,
        `${what} was written to throughout ${attempts} reads of it, so no copy was true at one moment and nothing was moved. Retry when it is quieter.`,
      );
    }
    return { state: newPageMove(next.attempt + 1), delayMs: storeMoveBackoffMs(next.attempt) };
  };
  for (;;) {
    const at = next.cursor;
    let page: Awaited<ReturnType<PageMoveEnds['read']>>;
    try {
      page = await ends.read(at);
    } catch (e) {
      if (!isConflict(e)) throw e;
      return restart(true);
    }
    if (next.revision !== null && page.revision !== next.revision) return restart(true);
    if (page.next !== null && page.next === at) {
      throw new ControlPlaneError(502, `${what} answered the cursor it was asked with, so its chain does not move`);
    }
    if (page.next !== null && next.reads + 1 >= STORE_MOVE_MAX_PAGES) {
      throw new ControlPlaneError(502, `${what} did not end in ${STORE_MOVE_MAX_PAGES} pages`);
    }
    let written: Awaited<ReturnType<PageMoveEnds['write']>>;
    try {
      written = await ends.write(next.moveId, next.seq, page.tables);
    } catch (e) {
      if (!isConflict(e)) throw e;
      return restart(true);
    }
    if (written.held) return restart(false);
    const known = new Set(next.tableNames);
    for (const table of page.tables) known.add(table.name);
    next = {
      ...next,
      seq: next.seq + (written.pages ?? 1),
      reads: next.reads + 1,
      cursor: page.next,
      revision: page.revision,
      tableNames: [...known],
      rows: next.rows + page.tables.reduce((n, t) => n + t.rows.length, 0),
    };
    if (page.next === null) return { done: next };
    if (opts.stopped?.() || opts.until?.()) return { state: next, delayMs: 0 };
  }
}

/** A store a move has finished: its stage or its page objects, as `moveId` names them. */
export interface MovedStore extends DeclaredScopeStore {
  moveId: string;
  revision: string;
  tables: number;
  /** Places in the far end's sequence: what a listing of a backup's pages is held to. */
  pages: number;
}

/** Several stores moved one after another. JSON, and holding no row: a job stores it. */
export interface StoreMovePlan {
  stores: DeclaredScopeStore[];
  at: number;
  move: PageMoveState;
  moved: MovedStore[];
  /** Pages moved over the whole plan, chains started over included: what a 202 reports. */
  pages: number;
}

export const newStorePlan = (stores: readonly DeclaredScopeStore[]): StoreMovePlan => ({
  stores: [...stores], at: 0, move: newPageMove(), moved: [], pages: 0,
});

export type StorePlanProgress = { done: MovedStore[] } | { state: StoreMovePlan; delayMs: number };
export type StorePlanEnds = (store: DeclaredScopeStore) => PageMoveEnds;

/** Every move a plan has at its far ends: the stores it finished, and the one it is on. */
export const movesOf = (plan: Pick<StoreMovePlan, 'stores' | 'at' | 'move' | 'moved'>): (DeclaredScopeStore & { moveId: string })[] => {
  const current = plan.stores[plan.at];
  return [...plan.moved, ...(current ? [{ ...current, moveId: plan.move.moveId }] : [])];
};

export const countingWrites = (ends: PageMoveEnds, wrote: (pages: number) => void): PageMoveEnds => ({
  ...ends,
  write: async (moveId, seq, tables) => {
    const written = await ends.write(moveId, seq, tables);
    wrote(written.pages ?? 1);
    return written;
  },
});

/** Move the plan's stores until they are all moved or the budget says to stop: always at least one page. */
export async function advanceStorePlan(
  endsOf: StorePlanEnds,
  plan: StoreMovePlan,
  opts: StorePlanOptions = {},
): Promise<StorePlanProgress> {
  let next = plan;
  opts.track?.(next);
  while (next.at < next.stores.length) {
    const store = next.stores[next.at]!;
    const before = next;
    let pagesNow = 0;
    const counted = countingWrites(endsOf(store), (pages) => { pagesNow += pages; });
    const progress = await movePages(counted, before.move, `scope store '${store.binding}'`, opts);
    if ('state' in progress) {
      return { state: { ...before, move: progress.state, pages: before.pages + pagesNow }, delayMs: progress.delayMs };
    }
    const { done } = progress;
    next = {
      ...before,
      at: before.at + 1,
      move: newPageMove(),
      pages: before.pages + pagesNow,
      moved: [...before.moved, {
        ...store, moveId: done.moveId, revision: done.revision!, tables: done.tableNames.length, pages: done.seq,
      }],
    };
    opts.track?.(next);
    if (next.at < next.stores.length && (opts.stopped?.() || opts.until?.())) return { state: next, delayMs: 0 };
  }
  return { done: next.moved };
}

/** Give up what a plan left at its ends, best effort, for a run nobody resumes. */
export async function abandonStorePlan(endsOf: StorePlanEnds, plan: StoreMovePlan): Promise<void> {
  for (const store of movesOf(plan)) {
    try {
      await endsOf(store).discard(store.moveId);
    } catch {
      // A stage goes by its age, and a page object with its backup's retention.
    }
  }
}

/**
 * How much of a move one request does before it is a job's, or is refused. A Worker invocation gets
 * 1000 subrequests on the paid plan, the figure `store-rebuild.ts` budgets against too.
 */
export interface StoreRequestBudget {
  /** Each page costs a read and a write, so 300 stay well inside those 1000. */
  pages: number;
  /** How long a request moves pages, ms. */
  ms: number;
  /** Default a real wait. A test injects none. */
  sleep?: (ms: number) => Promise<void>;
}

export const STORE_REQUEST_BUDGET: StoreRequestBudget = { pages: 300, ms: 20_000 };

/**
 * Run a plan inside one request's budget, waiting out a restart's backoff when the budget allows it.
 * A fault gives up what the run left, since a request has no next step; a plan the budget stopped is
 * answered, for the caller to hand to a job or give up (`abandonStorePlan`).
 */
export async function runStorePlanInRequest(
  endsOf: StorePlanEnds,
  plan: StoreMovePlan,
  budget: StoreRequestBudget = STORE_REQUEST_BUDGET,
): Promise<{ done: MovedStore[] } | { state: StoreMovePlan }> {
  const sleep = budget.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = Date.now();
  let moved = 0;
  const counted: StorePlanEnds = (store) => countingWrites(endsOf(store), (pages) => { moved += pages; });
  const spent = (): boolean => moved >= budget.pages || Date.now() - startedAt >= budget.ms;
  let last = plan;
  let progress: StorePlanProgress = { state: plan, delayMs: 0 };
  try {
    while ('state' in progress) {
      const { state, delayMs } = progress;
      if (spent() || Date.now() + delayMs - startedAt >= budget.ms) return { state };
      if (delayMs > 0) await sleep(delayMs);
      progress = await advanceStorePlan(counted, state, { until: spent, track: (now) => { last = now; } });
    }
  } catch (e) {
    await abandonStorePlan(endsOf, last);
    throw e;
  }
  return progress;
}

/**
 * A plan that did not finish in its request, on a route with nowhere to hand it. A chain that has
 * started over says so: that plan ran out of the request's budget under writes, not for its size.
 */
export const unfinishedInRequest = (what: string, plan: StoreMovePlan, way: string): ControlPlaneError =>
  new ControlPlaneError(
    409,
    plan.move.attempt > 1
      ? `${what} were written to while being read, so their chain started over and the request ran out before one finished. Nothing was changed. Retry when it is quieter. ${way}`
      : `${what} take too many pages to move in one request, and nothing was changed. ${way}`,
  );
