/**
 * The owner-seat read, remembering an ABSENT seat per running version (#1345).
 *
 * A vertical that keeps no owner seat answers `/internal/owner-seat` with 501 — correct,
 * and a capability signal — but Cloudflare counts every 501 as an errored invocation, so
 * asking on each app-detail render paints a declared-absent capability as a live error
 * rate. Whether a vertical keeps a seat is a property of its code, so the answer is
 * remembered against the version the scope runs: a push changes the version id and an
 * old entry can no longer match, rather than going stale.
 *
 * What this does not do: the first ask per browser per version still happens, and
 * with no known running version it always asks. The entry also expires after
 * `ABSENT_TTL_MS`, so a 501 that was really about the scope (briefly unbound) and not
 * about the code cannot hide a seat for good.
 *
 * Deliberately free of `./api` and of DOM types, so the worker-side test suite can
 * compile it — the read itself is passed in.
 */

/** The slice of `Storage` the memo uses — `localStorage` in the browser, a map in tests. */
export interface SeatMemoStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const ABSENT_TTL_MS = 24 * 60 * 60 * 1000;

const keyFor = (scopeId: string) => `substrat.dash.owner-seat-absent:${scopeId}`;

function browserStore(): SeatMemoStore | null {
  try {
    return (globalThis as { localStorage?: SeatMemoStore }).localStorage ?? null;
  } catch {
    // A storage-denied browser still gets the read, just not the memo.
    return null;
  }
}

/** A 501 from the dashboard API — an `ApiError`, read by its status rather than its class. */
function isNotImplemented(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { status?: unknown }).status === 501;
}

/** Whether this scope's seat is remembered as absent for exactly this running version. */
function rememberedAbsent(store: SeatMemoStore, scopeId: string, versionId: string, now: number): boolean {
  try {
    const raw = store.getItem(keyFor(scopeId));
    if (!raw) return false;
    const entry = JSON.parse(raw) as { versionId?: unknown; at?: unknown };
    // `at` must be a real instant in the PAST. A negative age satisfies the TTL just as
    // happily as a fresh one, so a clock rolled back — or an `at` of `1e999`, which
    // `JSON.parse` hands back as `Infinity` from a corrupted entry — would otherwise
    // remember an absent seat for good, which is the one thing the TTL exists to stop.
    const at = entry.at;
    const fresh = typeof at === 'number' && Number.isFinite(at) && now >= at && now - at < ABSENT_TTL_MS;
    if (entry.versionId === versionId && fresh) return true;
    // Another version's (or an expired) answer: it can never match again, so drop it.
    store.removeItem(keyFor(scopeId));
    return false;
  } catch {
    return false;
  }
}

/**
 * Reads already in flight, keyed by the pair the memo is keyed by.
 *
 * The memo is written only once `ask` has REJECTED, so two reads that start before that
 * both miss it and both issue the 501 — navigating away and back while the first is
 * pending, or the two cards on this page landing on one scope. "One ask per version" is
 * the whole claim of #1345, so the second read joins the first instead of racing it.
 *
 * Entries clear themselves when the promise settles, so this holds nothing between
 * renders; it is a coalescing window, not a second cache.
 */
const inFlight = new Map<string, Promise<unknown>>();

/**
 * Read the owner seat of `scopeId`, which runs `runningVersionId`, through `ask`. Resolves
 * `null` when the deployment keeps no seat (a 501 now, or remembered from one for this
 * version) — the same `null` the card already renders as "the platform cannot answer".
 * Any other failure rejects, exactly as the unwrapped read did, and is not remembered.
 */
export async function readOwnerSeat<T>(
  scopeId: string,
  runningVersionId: string | null,
  ask: (scopeId: string) => Promise<T>,
  opts: { store?: SeatMemoStore | null; now?: () => number } = {},
): Promise<T | null> {
  const store = opts.store === undefined ? browserStore() : opts.store;
  const now = opts.now ?? Date.now;
  if (store && runningVersionId && rememberedAbsent(store, scopeId, runningVersionId, now())) return null;

  const key = `${scopeId}\u0000${runningVersionId ?? ''}`;
  const joined = inFlight.get(key);
  if (joined) return (await joined) as T | null;

  const pending = (async () => {
    try {
      return await ask(scopeId);
    } catch (e) {
      if (!isNotImplemented(e)) throw e;
      if (store && runningVersionId) {
        try {
          store.setItem(keyFor(scopeId), JSON.stringify({ versionId: runningVersionId, at: now() }));
        } catch {
          // Quota or denied storage: the next render asks again, which is today's behaviour.
        }
      }
      return null;
    }
  })();
  inFlight.set(key, pending);
  // Both handlers, so the derived promise SETTLES: a bare `.finally` would reject in
  // parallel with nobody holding it, which is an unhandled rejection in the console for
  // every non-501 failure. The identity check leaves a newer entry alone.
  const clear = () => {
    if (inFlight.get(key) === pending) inFlight.delete(key);
  };
  pending.then(clear, clear);
  return pending;
}
