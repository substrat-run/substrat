/**
 * A refresh a push asked for, and the rule that it is not done until a read happened
 * (#938).
 *
 * A screen can decline a read: the inbox does while it is appending a page, because a
 * read landing mid-append would swallow the click. If the frame that asked were then
 * forgotten, and the poll timer restarted as though the read had happened, the change
 * it announced would stay invisible until the next poll, a minute away on a connected
 * inbox. So `reload` answers `false` when it declined. The refresh stays pending and is
 * tried again shortly, and the poll timer restarts only after a read actually ran.
 *
 * DOM-free, like `feed.ts`, so the node suite drives it with fake timers.
 */

type Timer = ReturnType<typeof setTimeout>;

export const REFRESH_TIMING = {
  /**
   * One write can announce several entities at once (a conversation and its message),
   * and each frame would otherwise be a full re-read. Requests this close together are
   * one read.
   */
  burstMs: 50,
  /** How soon a declined read is tried again. About the length of a page load. */
  retryMs: 500,
} as const;

export interface RefreshDeps {
  /** The screen's read. `false` means it declined and read nothing. */
  reload(): boolean | void;
  /** A read ran. The poll counts from it. */
  afterRead(): void;
  setTimeout(fn: () => void, ms: number): Timer;
  clearTimeout(timer: Timer): void;
}

export interface Refresh {
  /** Ask for a read soon. Requests while one is pending are the same request. */
  request(): void;
  cancel(): void;
}

export function createRefresh(deps: RefreshDeps): Refresh {
  let pending: Timer | null = null;

  function run(): void {
    pending = null;
    if (deps.reload() === false) {
      pending = deps.setTimeout(run, REFRESH_TIMING.retryMs);
      return;
    }
    deps.afterRead();
  }

  return {
    request() {
      if (pending !== null) return;
      pending = deps.setTimeout(run, REFRESH_TIMING.burstMs);
    },
    cancel() {
      if (pending !== null) deps.clearTimeout(pending);
      pending = null;
    },
  };
}
