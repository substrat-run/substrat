import { mergeDumpPages, type ScopeDumpTable, type ScopeId } from '@substrat-run/contracts';
import type { ReservedStoreCall } from '@substrat-run/kernel';
import { ControlPlaneError } from '@substrat-run/control-plane-client';
import type { DeclaredScopeStore } from './platform-scope-stores.js';
import { storeChainRead } from './store-move-ends.js';
import { movePages, newPageMove, STORE_REQUEST_BUDGET, type PageMoveEnds, type PageMoveProgress, type StoreRequestBudget } from './store-move.js';

/**
 * The most store data one answer of a pull or a tenant export holds, bytes, summed over its stores. A
 * pull answers one JSON body, whose string, parsed copy and serialized copy all live in one 128 MB
 * isolate. Over it, a pull refuses (413) rather than run out of memory.
 */
export const STORE_PULL_MAX_BYTES = 32_000_000;

/**
 * What a row costs the budget beyond its serialized bytes. A serialized byte is not the measure of a
 * parsed one: a body of 32 MB parses and serializes to about 170 MB of heap in rows of a few bytes and
 * about 35 MB in rows of 1 KB, measured, before the schema's copy of each page. With this charge the
 * worst measured at the limit is about 40 MB (D-69).
 */
export const STORE_PULL_ROW_BYTES = 64;

/** What one answer has left to hold, spent across its stores. */
export interface PullBudget {
  left: number;
  readonly limit: number;
}

/** What is true of every refusal here: where such a store's data can and cannot go today (D-69). */
const NO_EXPORT_PATH =
  'No path exports a store this large until links or a stream are decided (D-69). ' +
  'A backup holds it and restores it into its scope, and cannot be downloaded through the API.';

/**
 * One store's dump, whole, for a body that has to carry it: read in pages under `budget` and refused
 * (413) past it, before the pages that would not fit are held. There are two causes, and each refusal
 * names its own: the body's bytes, or the calls one request can make.
 */
export async function readStoreForBody(
  call: ReservedStoreCall,
  store: DeclaredScopeStore,
  scopeId: ScopeId | string,
  budget: PullBudget,
  request: StoreRequestBudget = STORE_REQUEST_BUDGET,
): Promise<ScopeDumpTable[]> {
  const sleep = request.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let held: ScopeDumpTable[][] = [];
  let heldBytes = 0;
  const readChain = storeChainRead(call, store.driver);
  // Across chains: a chain started over spends the same request's calls again.
  let reads = 0;
  const ends: PageMoveEnds = {
    read: (cursor) => {
      // A driver of tiny pages spends a request's calls before its bytes.
      if (reads >= request.pages) {
        throw new ControlPlaneError(
          413,
          `scope ${scopeId}'s store '${store.binding}' takes more than the ${request.pages} page reads one request can make, whatever its size in bytes. ${NO_EXPORT_PATH}`,
        );
      }
      reads += 1;
      return readChain(cursor);
    },
    write: async (_moveId, _seq, tables) => {
      const rows = tables.reduce((n, table) => n + table.rows.length, 0);
      const bytes = new TextEncoder().encode(JSON.stringify(tables)).length + rows * STORE_PULL_ROW_BYTES;
      if (heldBytes + bytes > budget.left) {
        // Said for scale. `substrat.size` counts stages too, and is not what was measured.
        const size = await call('substrat.size').then(({ bytes: b }) => ` It reports about ${b} bytes, stages included.`, () => '');
        throw new ControlPlaneError(
          413,
          `scope ${scopeId}'s store '${store.binding}' does not fit in one answer, which carries at most ${budget.limit} bytes of store data.${size} ${NO_EXPORT_PATH}`,
        );
      }
      held.push(tables);
      heldBytes += bytes;
      return { held: false };
    },
    discard: async () => {
      held = [];
      heldBytes = 0;
    },
  };
  let progress: PageMoveProgress = { state: newPageMove(), delayMs: 0 };
  while ('state' in progress) {
    if (progress.delayMs > 0) await sleep(progress.delayMs);
    progress = await movePages(ends, progress.state, `scope store '${store.binding}'`);
  }
  budget.left -= heldBytes;
  return mergeDumpPages(held);
}
