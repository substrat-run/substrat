/**
 * Roll a store-kind release across the verticals that declare it (#2297).
 * The first vertical is uploaded and canaried. The rest follow. A failure restores
 * every vertical that already moved, and then the error propagates.
 */
export async function rollOutStoreRelease(input: {
  readonly verticals: readonly string[];
  readonly upload: (vertical: string) => Promise<void>;
  readonly canary: (vertical: string) => Promise<void>;
  readonly restore: (vertical: string) => Promise<void>;
}): Promise<{ uploaded: string[] }> {
  if (input.verticals.length === 0) return { uploaded: [] };
  const [first, ...rest] = input.verticals;
  if (!first) return { uploaded: [] };
  const moved: string[] = [];
  try {
    await input.upload(first);
    moved.push(first);
    await input.canary(first);
    for (const vertical of rest) {
      await input.upload(vertical);
      moved.push(vertical);
    }
    return { uploaded: moved };
  } catch (err) {
    const restores: string[] = [];
    for (const vertical of moved) {
      try {
        await input.restore(vertical);
      } catch (restoreErr) {
        restores.push(`${vertical}: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}`);
      }
    }
    if (restores.length > 0) {
      throw new Error(
        `rollout failed and restore failed for ${restores.join('; ')}`,
        { cause: err },
      );
    }
    throw err;
  }
}
