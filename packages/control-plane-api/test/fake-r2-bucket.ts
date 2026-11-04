/**
 * A fake `R2Bucket` for the R2 stores' suites, with a settable list page size so a cursor walk
 * is actually exercised, and `failOn` to make a write of a chosen key throw as a bucket outage.
 */

export interface StoredObject {
  key: string;
  body: string;
  customMetadata?: Record<string, string>;
}

export function fakeBucket(pageSize = 100, opts: { failOn?: (key: string) => boolean } = {}) {
  const objects = new Map<string, StoredObject>();
  return {
    objects,
    bucket: {
      put: async (key: string, value: string, options?: { customMetadata?: Record<string, string> }) => {
        if (opts.failOn?.(key)) throw new Error('bucket unavailable');
        objects.set(key, { key, body: value, ...(options?.customMetadata ? { customMetadata: options.customMetadata } : {}) });
      },
      get: async (key: string) => {
        const o = objects.get(key);
        return o ? { text: async () => o.body } : null;
      },
      delete: async (key: string) => {
        objects.delete(key);
      },
      list: async (listOpts?: { prefix?: string; cursor?: string; include?: string[]; delimiter?: string }) => {
        const all = [...objects.values()]
          .filter((o) => (listOpts?.prefix ? o.key.startsWith(listOpts.prefix) : true))
          // Mirrors R2: with a delimiter, only the keys one level below the prefix are objects.
          .filter((o) => !listOpts?.delimiter || !o.key.slice(listOpts.prefix?.length ?? 0).includes(listOpts.delimiter))
          .sort((a, b) => (a.key < b.key ? -1 : 1));
        const from = listOpts?.cursor ? Number(listOpts.cursor) : 0;
        const slice = all.slice(from, from + pageSize);
        const next = from + pageSize;
        return {
          objects: slice.map((o) => ({
            key: o.key,
            size: o.body.length,
            // Mirrors R2: custom metadata only comes back when it was asked for.
            ...(listOpts?.include?.includes('customMetadata') && o.customMetadata
              ? { customMetadata: o.customMetadata }
              : {}),
          })),
          truncated: next < all.length,
          cursor: next < all.length ? String(next) : undefined,
        };
      },
    },
  };
}
