import {
  scopeBackupIndex,
  storeDriverDumpPageBytes,
  type ScopeBackupObject,
  type ScopeDump,
  type ScopeStoreBackup,
} from '@substrat-run/contracts';
import { storeDumpPages, writeStoreDump, type ReservedStoreCall } from '@substrat-run/kernel';
import { ControlPlaneError } from '@substrat-run/control-plane-client';
import { storedTables, type BackupAddress, type ScopeBackup, type ScopeBackupStore } from './backups.js';
import { isStoreBusy, RefusedAfterRetry, retryAfterOf, type DeclaredScopeStore, type PlatformScopeStores, type PlatformScopeStoreTarget } from './platform-scope-stores.js';
import { STORE_MOVE_MAX_PAGES, type MovedStore, type PageMoveEnds, type StorePlanEnds } from './store-move.js';

type Stores = Pick<PlatformScopeStores, 'callStore'>;
type Place = { tenantId: string; scopeId: string; vertical: string };

/**
 * The most pages a backup holds of one store, so its index stays what an isolate can read on every
 * step of a restore. Each page's entry is about 235 bytes, so this is 4.7 MB of JSON and about 7 MB of
 * heap to parse, where the chain's own limit of 100 000 would be 23 MB and about 34 MB, beside a page
 * and the schema's copy, in a 128 MB isolate (D-69). At the graph driver's declared 900 000 bytes it
 * holds about 18 GB.
 */
export const STORE_BACKUP_MAX_PAGES = 20_000;

/** The target of one store of a scope. */
const targetOf = (place: Place, store: DeclaredScopeStore): PlatformScopeStoreTarget => ({ ...place, ...store });

/** A store's chain as a move reads it: the driver's declared page size, nothing else asked. */
export const storeChainRead = (call: ReservedStoreCall, driver: string): PageMoveEnds['read'] =>
  (cursor) => call('substrat.export-page', { cursor, maxBytes: storeDriverDumpPageBytes(driver) });

const discardStage = (call: ReservedStoreCall) => async (moveId: string): Promise<void> => {
  await call('substrat.discard-stage', { stageId: moveId });
};

/** A snapshot's ends: source store to destination stage, nothing gathered. */
export const snapshotEnds = (
  stores: Stores,
  place: { tenantId: string; vertical: string; from: string; to: string },
): StorePlanEnds => (store) => {
  const dest = stores.callStore(targetOf({ ...place, scopeId: place.to }, store));
  return {
    read: storeChainRead(stores.callStore(targetOf({ ...place, scopeId: place.from }, store)), store.driver),
    // The source is live, so a page the stage already holds may have been cut otherwise: the chain
    // starts over rather than trust a stage this state cannot vouch for.
    write: async (moveId, seq, tables) => {
      const { staged } = await dest('substrat.stage-page', { stageId: moveId, seq, tables });
      return { held: !staged };
    },
    discard: discardStage(dest),
  };
};

export type BackupPlace = Place & { capturedAt: string };

/**
 * Refuse a backup that could not finish, before anything is written: a store whose size alone says it
 * takes more than the most a backup holds. `substrat.size` is the object's storage and counts stages,
 * so it is only an estimate, and only one over by twice is refused here. The rest is the cap's to say.
 */
export async function refuseOverCap(call: ReservedStoreCall, store: DeclaredScopeStore): Promise<void> {
  const { bytes } = await call('substrat.size');
  const pages = Math.ceil(bytes / storeDriverDumpPageBytes(store.driver));
  if (pages > 2 * STORE_BACKUP_MAX_PAGES) {
    throw new ControlPlaneError(
      413,
      `scope store '${store.binding}' reports about ${bytes} bytes, about ${pages} pages at its driver's size, and a backup holds at most ` +
        `${STORE_BACKUP_MAX_PAGES} pages of one store, so none was started.`,
    );
  }
}

/** A backup's ends: the store's chain to page objects under the backup's key, up to the most it holds. */
export const backupEnds = (deps: { stores: Stores; backups: ScopeBackupStore }, place: BackupPlace): StorePlanEnds => (store) => ({
  read: storeChainRead(deps.stores.callStore(targetOf(place, store)), store.driver),
  write: async (moveId, seq, tables) => {
    if (seq >= STORE_BACKUP_MAX_PAGES) {
      throw new ControlPlaneError(
        413,
        `scope store '${store.binding}' takes more than the ${STORE_BACKUP_MAX_PAGES} pages a backup holds of one store, ` +
          'so its index could not be read back in one isolate; nothing was kept.',
      );
    }
    await deps.backups.putStorePage({ ...place, moveId, seq, body: JSON.stringify({ tables }) });
    return { held: false };
  },
  discard: (moveId) => deps.backups.deleteMove({ ...place, moveId }),
});

/**
 * A restore's ends: a backup's page objects, each verified as it is read (`readObject`), to the
 * store's stage. A page missing or mangled refuses (422) before any commit, so the object stays as it
 * was. The cursor is the page's place in the index, and the revision is the one the index names.
 *
 * `from` is where the backup lies and `to` is the store it lands in: a reaped scope's backup restores
 * into a new scope, so the two are not one.
 *
 * Each stored page is cut again at `pageBytes`, one stored page at a time, so a backup survives its
 * driver lowering `dumpPageMaxBytes`, unless one row is itself past what the driver now takes: it rides
 * alone, and the driver or the 5 MB limit refuses it. The default is what the driver declares now; a job
 * fixes it in its spec, so its cuts stay the same across its steps.
 *
 * The pages are immutable and verified, and the same stored page cut at the same size is the same
 * pages, so a `staged: false` here means the stage already holds exactly this: a step resumed from a
 * record older than what it sent goes on from where its record says, and repeats nothing but calls.
 */
export const restoreEnds = (
  deps: { stores: Stores; backups: ScopeBackupStore },
  from: BackupAddress,
  to: Place,
  held: readonly ScopeStoreBackup[],
  pageBytes: (driver: string) => number = storeDriverDumpPageBytes,
): StorePlanEnds => (store) => {
  const index = held.find((s) => s.binding === store.binding);
  if (!index) throw new ControlPlaneError(422, `the backup's index names no store '${store.binding}'`);
  if (index.pageCount !== index.pages.length) {
    throw new ControlPlaneError(422, `the backup's index of store '${store.binding}' counts ${index.pageCount} pages and names ${index.pages.length}; nothing was moved`);
  }
  const call = deps.stores.callStore(targetOf(to, store));
  return {
    read: async (cursor) => {
      const at = cursor === null ? 0 : Number(cursor);
      const ref = index.pages[at];
      if (!ref) throw new ControlPlaneError(422, `the backup's index of store '${store.binding}' has no page ${at}; nothing was moved`);
      const body = await deps.backups.readObject({ ...from, ref });
      if (body === null) {
        throw new ControlPlaneError(422, `page ${at} of store '${store.binding}' is missing from the backup of ${from.capturedAt}; nothing was moved`);
      }
      const { tables } = storedTables.parse(JSON.parse(body));
      return { tables, next: at + 1 < index.pages.length ? String(at + 1) : null, revision: index.revision };
    },
    write: async (moveId, seq, tables) => {
      const cut = storeDumpPages(tables, pageBytes(store.driver));
      for (const [i, page] of cut.entries()) {
        await call('substrat.stage-page', { stageId: moveId, seq: seq + i, tables: page });
      }
      return { held: false, pages: cut.length };
    },
    discard: discardStage(call),
  };
};

/**
 * A store's landing that failed after a commit may have run: what was committed, and the binding
 * whose commit cannot be told (its answer was lost, or it answered another count). The route replays
 * erasures even so, since a store replaced by an old backup holds subjects erased since.
 */
export class StoreLandFailure extends ControlPlaneError {
  constructor(
    cause: unknown,
    readonly committed: readonly string[],
    readonly unknown: string | null,
    /** The committed bindings that did not come ready (`requireStoresReady`). */
    readonly notReady: readonly string[] = [],
  ) {
    super(cause instanceof ControlPlaneError ? cause.status : 502, cause instanceof Error ? cause.message : String(cause));
  }
}

const mayHaveLanded = (e: unknown): boolean =>
  !(e instanceof ControlPlaneError) || e instanceof RefusedAfterRetry || e.status === 0 || e.status >= 500;

/** Commit each moved store's stage, comparing each count with what was sent. Answers the bindings committed. */
export async function commitStages(stores: Stores, place: Place, moved: readonly MovedStore[]): Promise<string[]> {
  const committed: string[] = [];
  for (const store of moved) {
    let answer: { tables: number };
    try {
      answer = await stores.callStore(targetOf(place, store))('substrat.commit-stage', { stageId: store.moveId });
    } catch (e) {
      throw new StoreLandFailure(e, committed, mayHaveLanded(e) ? store.binding : null);
    }
    if (answer.tables !== store.tables) {
      throw new StoreLandFailure(
        new ControlPlaneError(502, `scope store '${store.binding}' committed ${answer.tables} tables of the ${store.tables} it was sent`),
        committed,
        store.binding,
      );
    }
    committed.push(store.binding);
  }
  return committed;
}

/** The most a restore waits, in all, for its committed stores to answer `substrat.selfcheck`, ms. */
export const STORE_READY_WAIT_MS = 30_000;
/** The wait before the probe after attempt `attempt`, ms: doubling from half a second to five. */
export const storeReadyBackoffMs = (attempt: number): number => Math.min(5_000, 500 * 2 ** (attempt - 1));

export interface StoreReadyWait {
  /** Default `STORE_READY_WAIT_MS`. */
  waitMs?: number;
  /** Default a real wait. A test injects its clock with `now`. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Probe each of these stores with `substrat.selfcheck`, which a driver answers once it can serve a call
 * (#2814). A store may bring restored data forward after its commit (D-69): a driver that restored an
 * older dump committed at the older schema version and migrates on later calls, answering 503 until it
 * is done and 500 if a step fails on those rows. `callStore` retries a transient fault over its own
 * short delays; past those, a 503 is waited for with backoff (a `Retry-After` honoured), all stores
 * sharing one `waitMs`, since a step of a job cannot be asked to sleep for a store. Any other answer, a
 * 5xx that is not 503 included, ends the wait for that store: a failed step does not clear by waiting.
 * Answers the bindings that did not come ready, in order, each with whether it was still busy.
 */
export async function awaitStoresReady(
  stores: Stores,
  place: Place,
  declared: readonly DeclaredScopeStore[],
  wait: StoreReadyWait = {},
): Promise<{ binding: string; busy: boolean; message: string }[]> {
  const waitMs = wait.waitMs ?? STORE_READY_WAIT_MS;
  const now = wait.now ?? Date.now;
  const sleep = wait.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = now();
  const notReady: { binding: string; busy: boolean; message: string }[] = [];
  for (const store of declared) {
    const call = stores.callStore(targetOf(place, store));
    for (let attempt = 1; ; attempt += 1) {
      try {
        await call('substrat.selfcheck');
        break;
      } catch (e) {
        const left = waitMs - (now() - startedAt);
        if (isStoreBusy(e) && left > 0) {
          await sleep(Math.min(left, Math.max(storeReadyBackoffMs(attempt), retryAfterOf(e))));
          continue;
        }
        notReady.push({ binding: store.binding, busy: isStoreBusy(e), message: e instanceof Error ? e.message : String(e) });
        break;
      }
    }
  }
  return notReady;
}

/**
 * Fail a restore whose committed stores are not all ready: `StoreLandFailure`, naming them, committed
 * as they are. Run after the last commit and before the erasure replay and the deployment's load,
 * since the replay calls `substrat.erase` on each store and the load makes the scope serve from them:
 * both would meet the same 503 or 500 instead of the cause. A store that stays busy may yet finish, and
 * one that failed a step cannot be repaired by asking again: it is wiped and another backup restored.
 */
export async function requireStoresReady(
  stores: Stores,
  place: Place,
  declared: readonly DeclaredScopeStore[],
  wait: StoreReadyWait = {},
): Promise<void> {
  const notReady = await awaitStoresReady(stores, place, declared, wait);
  if (notReady.length === 0) return;
  const named = notReady
    .map((n) => (n.busy ? `'${n.binding}' was still busy after ${wait.waitMs ?? STORE_READY_WAIT_MS} ms` : `'${n.binding}' failed its check (${n.message})`))
    .join('; ');
  throw new StoreLandFailure(
    new ControlPlaneError(
      502,
      `the restore was committed, but scope store ${named}, so it cannot serve yet. A store busy bringing its data forward may come ready; ` +
        'one whose step failed does not, and its driver logged why: wipe it and restore another backup.',
    ),
    declared.map((s) => s.binding),
    null,
    notReady.map((n) => n.binding),
  );
}

/** Discard these moves' stages, best effort: the driver drops an abandoned stage itself. */
export async function discardStages(stores: Stores, place: Place, moves: readonly (DeclaredScopeStore & { moveId: string })[]): Promise<void> {
  for (const stage of moves) {
    await stores.callStore(targetOf(place, stage))('substrat.discard-stage', { stageId: stage.moveId }).catch(() => undefined);
  }
}

/** A dump's stores, held whole, staged and committed in pages: an old backup's or an uploaded file's. Answers the bindings committed. */
export async function importWholeStores(stores: Stores, place: Place, dumps: ScopeDump['stores']): Promise<string[]> {
  const committed: string[] = [];
  for (const dump of dumps) {
    const call = stores.callStore(targetOf(place, dump));
    let committing = false;
    const watched = ((operation: string, input?: unknown) => {
      if (operation === 'substrat.commit-stage') committing = true;
      return call(operation as 'substrat.size', input);
    }) as ReservedStoreCall;
    try {
      await writeStoreDump(watched, dump.tables, storeDriverDumpPageBytes(dump.driver));
    } catch (e) {
      if (!committing && committed.length === 0) throw e;
      throw new StoreLandFailure(e, committed, committing && mayHaveLanded(e) ? dump.binding : null);
    }
    committed.push(dump.binding);
  }
  return committed;
}

/** Write the index, the one object that makes a backup, from the page objects its stores' moves left. */
export async function writeBackupIndex(
  backups: ScopeBackupStore,
  place: BackupPlace,
  scope: ScopeBackupObject & { tables: number },
  moved: readonly MovedStore[],
): Promise<ScopeBackup> {
  const stores: ScopeStoreBackup[] = [];
  for (const store of moved) {
    const pages = await backups.listStorePages({ ...place, moveId: store.moveId, pages: store.pages });
    if (pages.length !== store.pages) {
      throw new ControlPlaneError(502, `store '${store.binding}' wrote ${store.pages} pages and ${pages.length} can be listed`);
    }
    stores.push({
      binding: store.binding, driver: store.driver, revision: store.revision, tables: store.tables, pageCount: pages.length, pages,
    });
  }
  // Through the contract before it lands: an index that could not be read back is no backup.
  const index = scopeBackupIndex.parse({
    form: 'paged', tenantId: place.tenantId, scopeId: place.scopeId, capturedAt: place.capturedAt, scope, stores,
  });
  return backups.putIndex({ vertical: place.vertical, index });
}

/**
 * Whether a store holds any row, read at the smallest page the contract allows and stopped at the
 * first row, so a store of any size costs one call to answer yes. A write during the scan cannot make
 * this wrong for the caller: it asks about a binding no running version writes.
 */
export async function storeHoldsRows(call: ReservedStoreCall): Promise<boolean> {
  let cursor: string | null = null;
  for (let pages = 0; pages < STORE_MOVE_MAX_PAGES; pages += 1) {
    const page: { tables: { rows: unknown[] }[]; next: string | null } = await call('substrat.export-page', { cursor, maxBytes: 1 });
    if (page.tables.some((table) => table.rows.length > 0)) return true;
    if (page.next === null) return false;
    if (page.next === cursor) throw new ControlPlaneError(502, 'substrat.export-page answered the cursor it was asked with, so its chain does not move');
    cursor = page.next;
  }
  throw new ControlPlaneError(502, `substrat.export-page did not end in ${STORE_MOVE_MAX_PAGES} pages`);
}
