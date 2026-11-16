import type { ConnectionId } from '@substrat-run/contracts';
import type { HostAdmin } from '@substrat-run/kernel';

/**
 * The ids a scope has been handed, per resource — what the reconcile pass asks the store about, and
 * the reason it never reports an id it did not deliver (#3224).
 *
 * Kept in connector state, bucketed by id range ({@link SEEN_BUCKET_WIDTH} ids a row), so no one
 * row grows with the store: a shop with a hundred thousand orders is a few dozen small rows, and a
 * pass rewrites only the buckets it changed. Each id is either `live` (delivered, last seen at the
 * store) or `trashed` (its trashing was reported; watched until it is restored or deleted for good).
 */
export const SEEN_PREFIX = 'woocommerce:seen:';
export const SEEN_BUCKET_WIDTH = 10_000;

export type SeenResource = 'products' | 'orders';

interface Bucket {
  live: Set<number>;
  trashed: Set<number>;
}

interface StoredBucket {
  live: number[];
  trashed: number[];
}

export class SeenIds {
  private readonly buckets = new Map<number, Bucket>();
  private readonly dirty = new Set<number>();
  private loadedAll = false;

  constructor(
    private readonly admin: HostAdmin,
    private readonly connectionId: ConnectionId,
    private readonly scopeId: string,
    readonly resource: SeenResource,
  ) {}

  private prefix(): string {
    return `${SEEN_PREFIX}${this.scopeId}:${this.resource}:`;
  }

  private key(bucket: number): string {
    return `${this.prefix()}${bucket}`;
  }

  private static decode(value: unknown): Bucket {
    const v = (value ?? {}) as Partial<StoredBucket>;
    return { live: new Set(v.live ?? []), trashed: new Set(v.trashed ?? []) };
  }

  private async bucket(id: number): Promise<Bucket> {
    const b = Math.floor(id / SEEN_BUCKET_WIDTH);
    let held = this.buckets.get(b);
    if (held === undefined) {
      held = SeenIds.decode(this.loadedAll ? null : await this.admin.getConnectorState(this.connectionId, this.key(b)));
      this.buckets.set(b, held);
    }
    this.dirty.add(b);
    return held;
  }

  /** Read every bucket of this resource, once — what a reconcile pass starts from. */
  async loadAll(): Promise<void> {
    if (this.loadedAll) return;
    for (const { key, value } of await this.admin.listConnectorState(this.connectionId, this.prefix())) {
      const b = Number(key.slice(this.prefix().length));
      if (!Number.isInteger(b) || this.buckets.has(b)) continue;
      this.buckets.set(b, SeenIds.decode(value));
    }
    this.loadedAll = true;
  }

  /** Every tracked id, with whether its trashing was already reported. After {@link loadAll}. */
  all(): { id: number; trashed: boolean }[] {
    const out: { id: number; trashed: boolean }[] = [];
    for (const b of [...this.buckets.keys()].sort((x, y) => x - y)) {
      const { live, trashed } = this.buckets.get(b)!;
      for (const id of live) out.push({ id, trashed: false });
      for (const id of trashed) out.push({ id, trashed: true });
    }
    return out.sort((a, b) => a.id - b.id);
  }

  /** Delivered (or seen back at the store): live, and no longer watched as trashed. */
  async live(id: number): Promise<void> {
    const b = await this.bucket(id);
    b.trashed.delete(id);
    b.live.add(id);
  }

  async trashed(id: number): Promise<void> {
    const b = await this.bucket(id);
    b.live.delete(id);
    b.trashed.add(id);
  }

  /** Deleted for good, and reported: nothing left to watch. */
  async forget(id: number): Promise<void> {
    const b = await this.bucket(id);
    b.live.delete(id);
    b.trashed.delete(id);
  }

  get changed(): boolean {
    return this.dirty.size > 0;
  }

  /** Write the buckets this pass changed; an emptied bucket becomes a tombstone. */
  async flush(): Promise<void> {
    for (const b of this.dirty) {
      const { live, trashed } = this.buckets.get(b)!;
      const value: StoredBucket | null =
        live.size + trashed.size === 0 ? null : { live: [...live].sort((x, y) => x - y), trashed: [...trashed].sort((x, y) => x - y) };
      await this.admin.putConnectorState(this.connectionId, this.key(b), value);
    }
    this.dirty.clear();
  }
}
