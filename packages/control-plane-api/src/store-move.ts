import type { ScopeDumpPageTable } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { ControlPlaneError } from '@substrat-run/control-plane-client';
import type { DeclaredScopeStore } from './platform-scope-stores.js';

/**
 * A store's data moved a page at a time (D-69): out of a store's chain or a backup's store pages,
 * into a store's stage or a backup's store pages, holding one page.
 *
 * Its own stepper, not `transferStep` over `TransferEnds`: that one moves a scope, through a client
 * that names scope ids, a capture to catch up on, a `_substrat_meta` to fold, and a lease. A store has
 * one chain, an opaque revision and a driver's stage, so all that would be stubbed out. The shape is
 * the same: read a page, write it, next; a revision that moved starts again under a new id; nothing
 * changes the object until a commit.
 */
export interface PageMoveEnds {
  read(cursor: string | null): Promise<{ tables: ScopeDumpPageTable[]; next: string | null; revision: string }>;
  write(moveId: string, seq: number, tables: ScopeDumpPageTable[]): Promise<void>;
  /** Best effort: what a dropped move leaves goes with its stage's age, or with retention. */
  discard(moveId: string): Promise<void>;
}

/**
 * A chain in flight. `moveId` names its stage or its store pages; `seq` is the next place to write.
 * Plain JSON, so a job can keep it between steps.
 */
export interface PageMoveChain {
  moveId: string;
  seq: number;
  cursor: string | null;
  revision: string | null;
  attempt: number;
  /** The distinct tables seen so far: what a commit's count is compared with. */
  tableNames: string[];
}

const newChain = (attempt = 1): PageMoveChain => ({
  moveId: ulid(), seq: 0, cursor: null, revision: null, attempt, tableNames: [],
});

/** How many chains a move reads before it refuses: four waits, of 1, 2, 4 and 8 s. */
export const STORE_MOVE_ATTEMPTS = 5;
/** The wait before the chain after attempt `attempt`, ms. */
export const storeMoveBackoffMs = (attempt: number): number => 1_000 * 2 ** (attempt - 1);
/** The most pages one chain may have, as the kernel's reader has it: a longer one does not end. */
export const STORE_MOVE_MAX_PAGES = 100_000;

/** A store a move has finished: its stage or its store pages, as `moveId` names them. */
export interface MovedStore extends DeclaredScopeStore {
  moveId: string;
  revision: string;
  /** Distinct tables: what a commit answers again. */
  tables: number;
  /** Pages written, in order from 0. */
  pages: number;
}

export type StorePlanEnds = (store: DeclaredScopeStore) => PageMoveEnds;

/**
 * How much of a store move one request does (D-69): every page costs a read and a write, so 300 stay
 * well inside a Worker invocation's subrequests, and leave a restore room for its commits and its
 * erasure replay. Past it the move refuses with nothing changed, or, where the route has a job to hand
 * it to (`moveStoresOrHandOff`), goes on in the job.
 */
export interface StoreRequestBudget {
  pages: number;
  /** How long a request moves pages, ms, backoff included. */
  ms: number;
  /** Default a real wait. A test injects none. */
  sleep?: (ms: number) => Promise<void>;
}

export const STORE_REQUEST_BUDGET: StoreRequestBudget = { pages: 300, ms: 20_000 };

/**
 * A move of several stores, part way: the stores it moves in order, the one it is on, that store's
 * chain, the stores it has finished, and the pages written so far. Plain JSON, so a request that ran
 * out of budget can hand it to a job, and a job keeps it between steps. Nothing in it is data: the
 * pages are at the far end, under each chain's `moveId`.
 */
export interface StoreMovePlan {
  stores: DeclaredScopeStore[];
  /** The index in `stores` of the store `chain` reads. */
  at: number;
  chain: PageMoveChain;
  moved: MovedStore[];
  /** Pages written, over every chain that was kept. */
  pages: number;
}

export const newStoreMovePlan = (stores: readonly DeclaredScopeStore[]): StoreMovePlan => ({
  stores: stores.map(({ binding, driver }) => ({ binding, driver })), at: 0, chain: newChain(), moved: [], pages: 0,
});

/** Every move a plan made at its far ends: the stores it finished and the chain it is on. */
export const movesOf = (plan: StoreMovePlan): (DeclaredScopeStore & { moveId: string })[] => [
  ...plan.moved,
  ...(plan.at < plan.stores.length ? [{ ...plan.stores[plan.at]!, moveId: plan.chain.moveId }] : []),
];

/**
 * Whether a step stops here: after a page (`waitMs` 0) or before the wait a restarted chain owes
 * (`waitMs` > 0). Answering true hands the plan back as it stands, the wait still owed.
 */
export type StoreMoveYield = (plan: StoreMovePlan, waitMs: number) => boolean;

/** What a step ends with: every store moved, or the plan to go on with and the wait owed before it. */
export type StoreMoveStep = { moved: MovedStore[] } | { plan: StoreMovePlan; waitMs: number };

const isConflict = (e: unknown): boolean => e instanceof ControlPlaneError && e.status === 409;

/**
 * Move every store's chain in `plan`, one after another, until each is moved or `yieldAt` stops it.
 * A chain starts again under a new id, its pages so far discarded, when the revision moved (the pages
 * would be no one moment) or an end answers 409 (a driver refusing a read during writes, or a stage an
 * erase, a wipe or another writer dropped), after a wait of 1, 2, 4 and then 8 s. After
 * `STORE_MOVE_ATTEMPTS` chains it refuses (409). A refusal or a fault throws, and leaves the plan's
 * moves at their far ends for the caller to discard (`movesOf`).
 */
export async function stepStoreMoves(
  endsOf: StorePlanEnds,
  start: StoreMovePlan,
  opts: {
    yieldAt: StoreMoveYield;
    sleep: (ms: number) => Promise<void>;
    /** Told every plan as it changes, so a caller that catches a throw knows every move to discard. */
    track?: (plan: StoreMovePlan) => void;
  },
): Promise<StoreMoveStep> {
  let plan = start;
  const set = (next: StoreMovePlan): void => {
    plan = next;
    opts.track?.(next);
  };
  while (plan.at < plan.stores.length) {
    const store = plan.stores[plan.at]!;
    const ends = endsOf(store);
    const label = `scope store '${store.binding}'`;
    /** Drop this chain and start the store again; answers a wait to yield before, or none. */
    const restart = async (): Promise<number | undefined> => {
      const { chain } = plan;
      await ends.discard(chain.moveId).catch(() => undefined);
      if (chain.attempt >= STORE_MOVE_ATTEMPTS) {
        throw new ControlPlaneError(
          409,
          `${label} was written to throughout ${STORE_MOVE_ATTEMPTS} reads of it, so no copy was true at one moment and nothing was changed. Retry when it is quieter.`,
        );
      }
      const wait = storeMoveBackoffMs(chain.attempt);
      set({ ...plan, chain: newChain(chain.attempt + 1) });
      if (opts.yieldAt(plan, wait)) return wait;
      await opts.sleep(wait);
      return undefined;
    };
    for (;;) {
      const { chain } = plan;
      const at = chain.cursor;
      let page: Awaited<ReturnType<PageMoveEnds['read']>>;
      try {
        page = await ends.read(at);
      } catch (e) {
        if (!isConflict(e)) throw e;
        const wait = await restart();
        if (wait !== undefined) return { plan, waitMs: wait };
        continue;
      }
      if (chain.revision !== null && page.revision !== chain.revision) {
        const wait = await restart();
        if (wait !== undefined) return { plan, waitMs: wait };
        continue;
      }
      if (page.next !== null && page.next === at) {
        throw new ControlPlaneError(502, `${label} answered the cursor it was asked with, so its chain does not move`);
      }
      if (page.next !== null && chain.seq + 1 >= STORE_MOVE_MAX_PAGES) {
        throw new ControlPlaneError(502, `${label} did not end in ${STORE_MOVE_MAX_PAGES} pages`);
      }
      try {
        await ends.write(chain.moveId, chain.seq, page.tables);
      } catch (e) {
        if (!isConflict(e)) throw e;
        const wait = await restart();
        if (wait !== undefined) return { plan, waitMs: wait };
        continue;
      }
      const tableNames = [...new Set([...chain.tableNames, ...page.tables.map((table) => table.name)])];
      const next: PageMoveChain = { ...chain, seq: chain.seq + 1, cursor: page.next, revision: page.revision, tableNames };
      if (page.next === null) {
        const done: MovedStore = { ...store, moveId: next.moveId, revision: next.revision!, tables: tableNames.length, pages: next.seq };
        set({ ...plan, at: plan.at + 1, chain: newChain(), moved: [...plan.moved, done], pages: plan.pages + 1 });
        break;
      }
      set({ ...plan, chain: next, pages: plan.pages + 1 });
      if (opts.yieldAt(plan, 0)) return { plan, waitMs: 0 };
    }
  }
  return { moved: plan.moved };
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The refusal a move past one request's budget answers where nothing can go on with it. */
const overBudgetRefusal = (what: string, budget: StoreRequestBudget): ControlPlaneError =>
  new ControlPlaneError(
    409,
    `${what} take more than one request's budget of ${budget.pages} pages or ${budget.ms / 1000} s to move, so nothing was changed`,
  );

/**
 * Move every store inside one request's budget, or hand back where it got to. Past the budget (a page
 * more, or a wait that would end past it) the plan is answered as it stands, its moves still at their
 * far ends, for a job to go on with (`advanceStoreMoveJob`). On a refusal or a fault every move it made
 * is discarded, best effort, and the error thrown.
 */
export async function moveStoresOrHandOff(
  endsOf: StorePlanEnds,
  stores: readonly DeclaredScopeStore[],
  budget: StoreRequestBudget = STORE_REQUEST_BUDGET,
): Promise<StoreMoveStep> {
  const startedAt = Date.now();
  const yieldAt: StoreMoveYield = (plan, wait) => plan.pages >= budget.pages || Date.now() + wait - startedAt >= budget.ms;
  let plan = newStoreMovePlan(stores);
  try {
    return await stepStoreMoves(endsOf, plan, { yieldAt, sleep: budget.sleep ?? realSleep, track: (at) => { plan = at; } });
  } catch (e) {
    await discardMoves(endsOf, movesOf(plan));
    throw e;
  }
}

/**
 * Move every store inside one request's budget, where nothing can go on with it past that: past the
 * budget it refuses (409) with every move it made discarded, as on any refusal or fault. On success
 * the caller owns the moves.
 */
export async function moveStores(
  endsOf: StorePlanEnds,
  stores: readonly DeclaredScopeStore[],
  what: string,
  budget: StoreRequestBudget = STORE_REQUEST_BUDGET,
): Promise<MovedStore[]> {
  const step = await moveStoresOrHandOff(endsOf, stores, budget);
  if ('moved' in step) return step.moved;
  await discardMoves(endsOf, movesOf(step.plan));
  throw overBudgetRefusal(what, budget);
}

/** Give up these moves at their far ends, best effort: a stage goes by its age, a store page with its backup's retention. */
export async function discardMoves(endsOf: StorePlanEnds, moves: readonly (DeclaredScopeStore & { moveId: string })[]): Promise<void> {
  for (const move of moves) {
    await endsOf(move).discard(move.moveId).catch(() => undefined);
  }
}
