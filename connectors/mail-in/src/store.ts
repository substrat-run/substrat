/**
 * Where an accepted message waits until it is delivered. The control plane binds an R2 bucket; a
 * test binds a map. `put` must be durable before it resolves: the SMTP answer that follows it is the
 * platform telling the sender the message is safe.
 */
export interface MailInStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}

/** An in-memory store, for tests and a single-process host. */
export function memoryMailInStore(): MailInStore & { readonly keys: () => string[] } {
  const objects = new Map<string, Uint8Array>();
  return {
    put: async (key, bytes) => void objects.set(key, bytes.slice()),
    get: async (key) => objects.get(key)?.slice() ?? null,
    delete: async (key) => void objects.delete(key),
    keys: () => [...objects.keys()],
  };
}

/** The structural slice of an R2 bucket this store calls. */
export interface R2LikeBucket {
  put(key: string, value: Uint8Array): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(key: string): Promise<void>;
}

export function r2MailInStore(bucket: R2LikeBucket): MailInStore {
  return {
    put: async (key, bytes) => void (await bucket.put(key, bytes)),
    get: async (key) => {
      const obj = await bucket.get(key);
      return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
    },
    delete: (key) => bucket.delete(key),
  };
}
