import { describe, it, expect } from 'vitest';
import { rollOutStoreRelease } from '../src/store-rollout.js';

describe('a store-kind rollout canaries the first vertical and restores on failure (#2297)', () => {
  it('uploads the first, canaries it, then uploads the rest', async () => {
    const events: string[] = [];
    const result = await rollOutStoreRelease({
      verticals: ['one', 'two'],
      upload: async (vertical) => {
        events.push(`upload ${vertical}`);
      },
      canary: async (vertical) => {
        events.push(`canary ${vertical}`);
      },
      restore: async (vertical) => {
        events.push(`restore ${vertical}`);
      },
    });
    expect(result.uploaded).toEqual(['one', 'two']);
    expect(events).toEqual(['upload one', 'canary one', 'upload two']);
  });

  it('restores the verticals that already moved when a later upload fails', async () => {
    const restored: string[] = [];
    await expect(
      rollOutStoreRelease({
        verticals: ['one', 'two'],
        upload: async (vertical) => {
          if (vertical === 'two') throw new Error('upload failed');
        },
        canary: async () => undefined,
        restore: async (vertical) => {
          restored.push(vertical);
        },
      }),
    ).rejects.toThrow(/upload failed/);
    expect(restored).toEqual(['one']);
  });

  it('an empty fleet uploads nothing', async () => {
    const result = await rollOutStoreRelease({
      verticals: [],
      upload: async () => {
        throw new Error('no');
      },
      canary: async () => undefined,
      restore: async () => undefined,
    });
    expect(result.uploaded).toEqual([]);
  });
});
