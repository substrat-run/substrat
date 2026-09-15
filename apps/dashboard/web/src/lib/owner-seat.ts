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
    if (entry.versionId === versionId && typeof entry.at === 'number' && now - entry.at < ABSENT_TTL_MS) return true;
    // Another version's (or an expired) answer: it can never match again, so drop it.
    store.removeItem(keyFor(scopeId));
    return false;
  } catch {
    return false;
  }
}

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
}
