/**
 * Bolagsverket's limit: 60 requests a minute per client.
 *
 * A sliding window rather than a fixed one-second spacing: a validation burst (a list
 * imported, a form saved twice) goes through at once and only waits when the 61st
 * request in a minute is genuinely due.
 *
 * The window models this client's own traffic. The limit is per CLIENT (credential), so a
 * caller holding several `BolagsverketApi` instances on one credential passes one shared
 * `sent` array to all of them. Traffic the window cannot see — another isolate on the same
 * credential — is absorbed by the 429 retry in `api.ts`, which obeys `Retry-After`.
 */
export const RATE_LIMIT_REQUESTS = 60;
export const RATE_LIMIT_WINDOW_MS = 60_000;

export class SlidingWindow {
  constructor(
    private readonly now: () => number,
    private readonly sleep: (ms: number) => Promise<void>,
    /** When the requests still inside the window went out, oldest first. */
    private readonly sent: number[] = [],
  ) {}

  private prune(): void {
    const cutoff = this.now() - RATE_LIMIT_WINDOW_MS;
    while (this.sent.length > 0 && this.sent[0]! <= cutoff) this.sent.shift();
  }

  /** Wait until one more request fits, then count it. */
  async acquire(): Promise<void> {
    this.prune();
    if (this.sent.length >= RATE_LIMIT_REQUESTS) {
      // The oldest request leaving the window is the earliest moment a new one fits.
      const waitMs = this.sent[0]! + RATE_LIMIT_WINDOW_MS - this.now();
      if (waitMs > 0) await this.sleep(waitMs);
      this.prune();
    }
    this.sent.push(this.now());
  }
}

/**
 * `Retry-After` in milliseconds. A missing or unreadable value falls back to the whole
 * window, the only wait guaranteed to clear a per-minute limit, and a long one is capped
 * so a provider answering with an hour does not become an hour-long hung request.
 */
export function retryAfterMs(header: string | null): number {
  const seconds = header === null ? Number.NaN : Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return RATE_LIMIT_WINDOW_MS;
  return Math.min(seconds * 1000, RATE_LIMIT_WINDOW_MS * 2);
}
