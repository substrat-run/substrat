const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Run `fn` over `items` with at most `limit` in flight. `fn` owns its errors —
 * this never rejects, so one unit's failure cannot abort the pass.
 */
async function mapBounded<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      await fn(items[next++]!);
    }
  });
  await Promise.all(workers);
}
