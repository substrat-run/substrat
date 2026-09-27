import type { PlatformRequestBacklog, SweepRunEntry, SystemSwitchRecord, Vertical, VerticalChannel } from '@substrat-run/contracts';

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

/** The kill-switch tile's fleet totals (#1690 §2), from a `GET /system-switches` walk. */
export interface SystemSwitchSummary {
  scopes: number;
  tenants: number;
}

/** One record per (scope, module) held off, so scope/tenant counts are over the distinct ids. */
export function summarizeSystemSwitches(rows: Pick<SystemSwitchRecord, 'tenantId' | 'scopeId'>[]): SystemSwitchSummary {
  return { scopes: new Set(rows.map((r) => r.scopeId)).size, tenants: new Set(rows.map((r) => r.tenantId)).size };
}

/**
 * The platform sweep runs every 15 minutes (the control plane's cron), and each pass writes
 * the drain row the pending count is read from (#1840). Three missed passes and the count is
 * old enough that the tile should say so rather than let it read as current.
 */
export const PENDING_STALE_MINUTES = 45;

/** How the tile reads a `PlatformRequestBacklog.pending`, beside the failure count. */
export type PendingReading =
  /** No drain pass on record — never shown as 0, which is a different fact. */
  | { kind: 'none' }
  | { kind: 'count'; count: number; floor: boolean; minutesAgo: number; stale: boolean };

/**
 * `undefined` as well as `null`: a control plane older than #1840 sends no `pending` at all,
 * and that too is "not on record", never zero.
 */
export function readPending(pending: PlatformRequestBacklog['pending'] | undefined, now: number): PendingReading {
  if (!pending) return { kind: 'none' };
  const minutesAgo = Math.max(0, Math.floor((now - Date.parse(pending.asOf)) / 60_000));
  return { kind: 'count', count: pending.count, floor: pending.floor, minutesAgo, stale: minutesAgo > PENDING_STALE_MINUTES };
}

/** The tile's sentence for a pending reading — always its age, and why it may be low. */
export function pendingCaption(reading: PendingReading): string {
  if (reading.kind === 'none') return 'Pending: no sweep pass on record yet, so nothing is known about what is waiting.';
  const stale = reading.stale ? '; the sweep has not recorded a pass since' : '';
  const floor = reading.floor ? '. At least this many: some scopes could not be drained that pass' : '';
  return `Pending: still waiting as of the last sweep pass, ${reading.minutesAgo} min ago — not live${stale}${floor}.`;
}

/** How many rows the "Sweep loops" tile shows. */
export const SWEEP_LOOP_ROWS = 20;

/**
 * The "Sweep loops" tile's rows (#1840): sweep UNITS only. The `platform-request` row is
 * the drain's fleet-wide pass summary, written every pass — left in, it would always be
 * "last", and a floor pass would paint the tile red over units that all swept fine. It has
 * its own tile (Platform requests).
 */
export function sweepLoopRows<T extends Pick<SweepRunEntry, 'kind'>>(rows: T[]): T[] {
  return rows.filter((r) => r.kind !== 'platform-request').slice(0, SWEEP_LOOP_ROWS);
}
