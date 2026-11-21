import type { ConnectionId } from '@substrat-run/contracts';
import type { HostAdmin } from '@substrat-run/kernel';

/**
 * The ids a scope has been handed, per resource — what the reconcile pass asks the shop about, and
 * the reason it never reports an id it did not deliver.
 *
 * Kept in connector state in {@link SEEN_BUCKETS} rows per resource, an id going to the row its
 * remainder names. WooCommerce buckets by id RANGE, because a store numbers its rows densely from 1;
 * Shopify's ids are drawn from one sequence across every shop on the platform, so one shop's ids are
 * thirteen-digit numbers far apart, and a range bucket would hold one id each. A remainder spreads
 * them evenly over a fixed number of rows instead: a shop with a hundred thousand orders keeps 64
 * rows of about twenty kilobytes, and a pass rewrites only the rows it changed.
 *
 * Shopify has no trash: a record is there or it is deleted, so an id is only ever delivered or
 * forgotten.
 */
export const SEEN_PREFIX = 'shopify:seen:';
export const SEEN_BUCKETS = 64;

export type SeenResource = 'products' | 'orders';

export class SeenIds {
  private readonly buckets = new Map<number, Set<number>>();
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

  private static decode(value: unknown): Set<number> {
    const ids = (value as { ids?: unknown } | null)?.ids;
    return new Set(Array.isArray(ids) ? ids.filter((id): id is number => Number.isSafeInteger(id)) : []);
  }

  private async bucket(id: number): Promise<Set<number>> {
    const b = id % SEEN_BUCKETS;
    let held = this.buckets.get(b);
    if (held === undefined) {
      held = SeenIds.decode(this.loadedAll ? null : await this.admin.getConnectorState(this.connectionId, `${this.prefix()}${b}`));
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

  /** Every delivered id, ascending. After {@link loadAll}. */
  all(): number[] {
    return [...this.buckets.values()].flatMap((ids) => [...ids]).sort((a, b) => a - b);
  }

  async live(id: number): Promise<void> {
    (await this.bucket(id)).add(id);
  }

  /** Deleted, and reported: nothing left to watch. */
  async forget(id: number): Promise<void> {
    (await this.bucket(id)).delete(id);
  }

  /** Write the buckets this pass changed; an emptied bucket becomes a tombstone. */
  async flush(): Promise<void> {
    for (const b of this.dirty) {
      const ids = this.buckets.get(b)!;
      await this.admin.putConnectorState(this.connectionId, `${this.prefix()}${b}`, ids.size === 0 ? null : { ids: [...ids].sort((x, y) => x - y) });
    }
    this.dirty.clear();
  }
}
