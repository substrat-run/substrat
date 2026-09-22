/**
 * Run `fn` unless a previous run guarded by the same flag is still in flight.
 *
 * A ref, not React state: two clicks in the same tick both read a `useState` flag as
 * false, because the setter only lands on the next render. That is exactly how a
 * "Load more" button asked for the same cursor twice and appended the page twice.
 * Resolves `false` when the call was skipped. The flag is released even when `fn` throws.
 */
export async function runExclusive(flag: { current: boolean }, fn: () => Promise<void>): Promise<boolean> {
  if (flag.current) return false;
  flag.current = true;
  try {
    await fn();
    return true;
  } finally {
    flag.current = false;
  }
}
