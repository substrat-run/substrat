import type { Vertical, VerticalChannel } from '@substrat-run/contracts';

// An ordinary in-flight promote must not light up the tile.
export const PROMOTE_TRAILING_MINUTES = 10;
const CHANNEL_READ_CONCURRENCY = 4;

/** Independent channel reads overlap without sending the whole fleet at once. */
export async function countTrailingPromotes(
  verticals: Pick<Vertical, 'slug' | 'servingRef'>[],
  listChannels: (slug: string) => Promise<{ entries: VerticalChannel[] }>,
  now: number,
): Promise<number> {
  const pending = verticals.filter((v) => v.servingRef);
  let next = 0;
  let count = 0;
  await Promise.all(Array.from({ length: Math.min(CHANNEL_READ_CONCURRENCY, pending.length) }, async () => {
    while (next < pending.length) {
      const vertical = pending[next++]!;
      // Only prod exists; the default channel page holds it whole.
      const channels = await listChannels(vertical.slug);
      const prod = channels.entries.find((c) => c.channel === 'prod');
      if (!prod || prod.servingVersionId === prod.versionId) continue;
      if ((now - Date.parse(prod.updatedAt)) / 60_000 > PROMOTE_TRAILING_MINUTES) count += 1;
    }
  }));
  return count;
}
