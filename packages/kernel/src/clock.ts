import { instant, type Instant } from '@substrat-run/contracts';
import type { Clock } from './scope-host.js';

/**
 * Test and replay clocks (#812) — the reason `ctx.now()` is injected rather than
 * read.
 *
 * Shipped from the kernel rather than a test package for the same reason
 * `UNSAFE_allowAllChecker` is: the seam belongs with the type it implements, and
 * a vertical's own scenario suite needs it without taking a dependency on our
 * test tooling. Nothing here is unsafe — a host given a fixed clock behaves
 * exactly as it would at that moment.
 *
 * What this makes testable that was not: anything whose behaviour is a function
 * of elapsed time. An absence request going stale, a metering period rolling, a
 * cart hold lapsing. Before the seam existed those were either asserted against
 * the wall clock — which means asserting nothing, since the interesting branch
 * never runs in a 40ms test — or quietly left unasserted.
 */

/** A clock stopped at one instant. Every read returns it. */
export function frozenClock(at: string | Date): Clock {
  const value = instant.parse(typeof at === 'string' ? at : at.toISOString());
  return () => value;
}

/**
 * A clock a test moves ON PURPOSE.
 *
 * Time passes when the test says so and never otherwise, which is what turns
 * "wait for the hold to lapse" from a `setTimeout` that makes the suite slow and
 * flaky into an assertion that is exact and instant:
 *
 * ```ts
 * const clock = manualClock('2026-01-01T09:00:00.000Z');
 * const host = new SqliteScopeHost({ dir, clock: clock.read });
 * await stub.invoke('shop/add-to-cart', { variantId, qty: 1 });
 * clock.advance(20 * 60_000);              // the hold's 15 minutes have passed
 * expect(await stub.invoke('shop/cart')).toMatchObject({ lines: [] });
 * ```
 */
export interface ManualClock {
  /** Pass this as the host's `clock`. */
  read: Clock;
  /** The instant the clock currently reads. */
  now(): Instant;
  /** Move forward (or back, with a negative value) by milliseconds. */
  advance(ms: number): Instant;
  /** Jump to an exact instant. */
  set(at: string | Date): Instant;
}

export function manualClock(start: string | Date = '2026-01-01T00:00:00.000Z'): ManualClock {
  let current = instant.parse(typeof start === 'string' ? start : start.toISOString());
  const set = (at: string | Date): Instant => {
    current = instant.parse(typeof at === 'string' ? at : at.toISOString());
    return current;
  };
  return {
    read: () => current,
    now: () => current,
    advance: (ms: number) => set(new Date(Date.parse(current) + ms)),
    set,
  };
}
