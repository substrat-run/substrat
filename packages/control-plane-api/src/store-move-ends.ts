import { storeDriverDumpPageBytes, type ScopeDumpPageTable, type ScopeDumpTable } from '@substrat-run/contracts';
import { storeDumpPages, type ReservedStoreCall } from '@substrat-run/kernel';
import { ControlPlaneError } from '@substrat-run/control-plane-client';
import type { ScopeBackupWriter } from './backups.js';
import type { DeclaredScopeStore, PlatformScopeStores } from './platform-scope-stores.js';
import { STORE_MOVE_MAX_PAGES, type MovedStore, type PageMoveEnds, type StorePlanEnds } from './store-move.js';

/** Where a scope's stores are: the store of each binding is one object of this scope. */
export interface StorePlace {
  tenantId: string;
  scopeId: string;
  vertical: string;
}

const callAt = (caller: PlatformScopeStores, place: StorePlace, store: DeclaredScopeStore): ReservedStoreCall =>
  caller.callStore({ ...place, ...store });

/** A store's chain as a move reads it: the driver's declared page size, nothing else asked. */
const chainRead = (call: ReservedStoreCall, driver: string): PageMoveEnds['read'] =>
  (cursor) => call('substrat.export-page', { cursor, maxBytes: storeDriverDumpPageBytes(driver) });

/** A store's stage as a move writes it. Each page goes once under a fresh id, so `staged: false` is the driver's fault. */
const stageEnds = (call: ReservedStoreCall, binding: string): Pick<PageMoveEnds, 'write' | 'discard'> => ({
  write: async (moveId, seq, tables) => {
    const { staged } = await call('substrat.stage-page', { stageId: moveId, seq, tables });
    if (!staged) throw new ControlPlaneError(502, `scope store '${binding}' held page ${seq} of a stage it was only just given`);
  },
  discard: async (moveId) => {
    await call('substrat.discard-stage', { stageId: moveId });
  },
});

/** A snapshot's ends: the source's store, page by page, into a stage at the fork's. */
export const snapshotEnds = (caller: PlatformScopeStores, from: StorePlace, to: StorePlace): StorePlanEnds => (store) => ({
  read: chainRead(callAt(caller, from, store), store.driver),
  ...stageEnds(callAt(caller, to, store), store.binding),
});

/** A backup's ends: the store's chain into `store-page` entries of the backup being written, under the move's id. */
export const backupEnds = (caller: PlatformScopeStores, place: StorePlace, writer: ScopeBackupWriter): StorePlanEnds => (store) => ({
  read: chainRead(callAt(caller, place, store), store.driver),
  write: (moveId, seq, tables) => writer.put(moveId, seq, { kind: 'store-page', tables }),
  discard: (moveId) => writer.discard(moveId),
});

/** A store's pages as a restore reads them: a backup's `store-page` entries, or an inline dump cut into pages. */
export interface StoreSource {
  pages: number;
  revision: string;
  page(seq: number): Promise<ScopeDumpPageTable[]>;
}

/** An inline store (an older backup's, or an uploaded dump's) as a source: cut at its driver's page size. */
export const inlineStoreSource = (store: { driver: string; tables: readonly ScopeDumpTable[] }): StoreSource => {
  const pages = storeDumpPages(store.tables, storeDriverDumpPageBytes(store.driver));
  return { pages: pages.length, revision: 'inline', page: async (seq) => pages[seq]! };
};

/**
 * A restore's ends: each store's source into a stage at the destination. A page that cannot be read
 * or parsed refuses before any commit, so the store stays as it was.
 */
export const restoreEnds = (caller: PlatformScopeStores, to: StorePlace, sourceOf: (binding: string) => StoreSource): StorePlanEnds =>
  (store) => {
    const source = sourceOf(store.binding);
    return {
      read: async (cursor) => {
        const seq = cursor === null ? 0 : Number(cursor);
        return { tables: await source.page(seq), next: seq + 1 < source.pages ? String(seq + 1) : null, revision: source.revision };
      },
      ...stageEnds(callAt(caller, to, store), store.binding),
    };
  };

/**
 * A store's landing that failed once a commit was attempted: which bindings were committed, and
 * which were not. The commit of `failed` may have run with its answer lost, so the store under it is
 * either. The route replays erasures even so, since a store replaced by an old copy holds subjects
 * erased since, and running the restore again converges: every commit is a whole replace.
 */
export class StoreLandFailure extends ControlPlaneError {
  constructor(
    cause: unknown,
    readonly committed: readonly string[],
    readonly uncommitted: readonly string[],
  ) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(
      cause instanceof ControlPlaneError ? cause.status : 502,
      `${message}. The scope's stores were committed in part: ${committed.length ? committed.join(', ') : 'none'} committed, ` +
        `${uncommitted.join(', ')} not known to be; restore again to finish`,
    );
  }
}

/**
 * Commit each moved store's stage, comparing each count with what was sent. The contract makes a
 * commit asked again answer the same count and change nothing, so a transient fault is retried. Any
 * failure throws a `StoreLandFailure`, and the stages not committed are discarded, best effort.
 */
export async function commitStages(
  caller: PlatformScopeStores,
  place: StorePlace,
  moved: readonly MovedStore[],
  retry: <T>(run: () => Promise<T>) => Promise<T>,
): Promise<string[]> {
  const committed: string[] = [];
  for (const [at, store] of moved.entries()) {
    const call = callAt(caller, place, store);
    try {
      const answer = await retry(() => call('substrat.commit-stage', { stageId: store.moveId }));
      if (answer.tables !== store.tables) {
        throw new ControlPlaneError(502, `scope store '${store.binding}' committed ${answer.tables} tables of the ${store.tables} it was sent`);
      }
    } catch (e) {
      const rest = moved.slice(at);
      for (const left of rest.slice(1)) await callAt(caller, place, left)('substrat.discard-stage', { stageId: left.moveId }).catch(() => undefined);
      throw new StoreLandFailure(e, committed, rest.map((s) => s.binding));
    }
    committed.push(store.binding);
  }
  return committed;
}

/**
 * Whether a store holds any row, read at the smallest page the contract allows and stopped at the
 * first row, so a store of any size costs one call to answer yes. A write during the scan cannot make
 * this wrong for the caller: it asks about a binding no running version writes.
 */
export async function storeHoldsRows(caller: PlatformScopeStores, place: StorePlace, store: DeclaredScopeStore): Promise<boolean> {
  const call = callAt(caller, place, store);
  const asked = new Set<string>();
  let cursor: string | null = null;
  for (let pages = 1; ; pages += 1) {
    const page: { tables: { rows: unknown[] }[]; next: string | null } = await call('substrat.export-page', { cursor, maxBytes: 1 });
    if (page.tables.some((table) => table.rows.length > 0)) return true;
    if (page.next === null) return false;
    if (cursor !== null) asked.add(cursor);
    if (asked.has(page.next) || page.next === cursor || pages >= STORE_MOVE_MAX_PAGES) {
      throw new ControlPlaneError(502, `scope store '${store.binding}' answered a chain that does not end`);
    }
    cursor = page.next;
  }
}
