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

/** A chain in flight. `moveId` names its stage or its store pages; `seq` is the next place to write. */
interface PageMoveState {
  moveId: string;
  seq: number;
  cursor: string | null;
  revision: string | null;
  attempt: number;
  /** The distinct tables seen so far: what a commit's count is compared with. */
  tableNames: Set<string>;
}

const newPageMove = (attempt = 1): PageMoveState => ({
  moveId: ulid(), seq: 0, cursor: null, revision: null, attempt, tableNames: new Set(),
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
 * well inside a Worker invocation's 1000 subrequests, and leave a restore room for its commits and its
 * erasure replay. There is no job to hand the rest to, so past it the move refuses with nothing changed.
 */
export interface StoreRequestBudget {
  pages: number;
  /** How long a request moves pages, ms, backoff included. */
  ms: number;
  /** Default a real wait. A test injects none. */
  sleep?: (ms: number) => Promise<void>;
}

export const STORE_REQUEST_BUDGET: StoreRequestBudget = { pages: 300, ms: 20_000 };

const isConflict = (e: unknown): boolean => e instanceof ControlPlaneError && e.status === 409;

/**
 * Move every store's chain, one after another, inside one request's budget. A chain starts again
 * under a new id, its pages so far discarded, when the revision moved (the pages would be no one
 * moment) or an end answers 409 (a driver refusing a read during writes, or a stage an erase, a wipe
 * or another writer dropped), after a wait of 1, 2, 4 and then 8 s. After `STORE_MOVE_ATTEMPTS`
 * chains, or past the budget, it refuses (409). On any refusal or fault every move it made is
 * discarded, best effort, so the far ends hold nothing of it; on success the caller owns the moves.
 */
export async function moveStores(
  endsOf: StorePlanEnds,
  stores: readonly DeclaredScopeStore[],
  what: string,
  budget: StoreRequestBudget = STORE_REQUEST_BUDGET,
): Promise<MovedStore[]> {
  const sleep = budget.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = Date.now();
  let pages = 0;
  const moved: MovedStore[] = [];
  let current: { store: DeclaredScopeStore; moveId: string } | undefined;
  const overBudget = (wait = 0): ControlPlaneError | undefined =>
    pages >= budget.pages || Date.now() + wait - startedAt >= budget.ms
      ? new ControlPlaneError(
          409,
          `${what} take more than one request's budget of ${budget.pages} pages or ${budget.ms / 1000} s to move, so nothing was changed`,
        )
      : undefined;
  try {
    for (const store of stores) {
      const ends = endsOf(store);
      const label = `scope store '${store.binding}'`;
      let state = newPageMove();
      current = { store, moveId: state.moveId };
      for (;;) {
        const restart = async (): Promise<void> => {
          await ends.discard(state.moveId).catch(() => undefined);
          if (state.attempt >= STORE_MOVE_ATTEMPTS) {
            throw new ControlPlaneError(
              409,
              `${label} was written to throughout ${STORE_MOVE_ATTEMPTS} reads of it, so no copy was true at one moment and nothing was changed. Retry when it is quieter.`,
            );
          }
          const wait = storeMoveBackoffMs(state.attempt);
          const over = overBudget(wait);
          if (over) throw over;
          await sleep(wait);
          state = newPageMove(state.attempt + 1);
          current = { store, moveId: state.moveId };
        };
        const at = state.cursor;
        let page: Awaited<ReturnType<PageMoveEnds['read']>>;
        try {
          page = await ends.read(at);
        } catch (e) {
          if (!isConflict(e)) throw e;
          await restart();
          continue;
        }
        if (state.revision !== null && page.revision !== state.revision) {
          await restart();
          continue;
        }
        if (page.next !== null && page.next === at) {
          throw new ControlPlaneError(502, `${label} answered the cursor it was asked with, so its chain does not move`);
        }
        if (page.next !== null && state.seq + 1 >= STORE_MOVE_MAX_PAGES) {
          throw new ControlPlaneError(502, `${label} did not end in ${STORE_MOVE_MAX_PAGES} pages`);
        }
        try {
          await ends.write(state.moveId, state.seq, page.tables);
        } catch (e) {
          if (!isConflict(e)) throw e;
          await restart();
          continue;
        }
        pages += 1;
        for (const table of page.tables) state.tableNames.add(table.name);
        state = { ...state, seq: state.seq + 1, cursor: page.next, revision: page.revision };
        if (page.next === null) break;
        const over = overBudget();
        if (over) throw over;
      }
      moved.push({ ...store, moveId: state.moveId, revision: state.revision!, tables: state.tableNames.size, pages: state.seq });
      current = undefined;
    }
  } catch (e) {
    await discardMoves(endsOf, [...moved, ...(current ? [{ ...current.store, moveId: current.moveId }] : [])]);
    throw e;
  }
  return moved;
}

/** Give up these moves at their far ends, best effort: a stage goes by its age, a store page with its backup's retention. */
export async function discardMoves(endsOf: StorePlanEnds, moves: readonly (DeclaredScopeStore & { moveId: string })[]): Promise<void> {
  for (const move of moves) {
    await endsOf(move).discard(move.moveId).catch(() => undefined);
  }
}
