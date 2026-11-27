/**
 * Platform usage, priced (#3316): what a team's apps used of Cloudflare, per day, and what it
 * would cost at the platform's price.
 *
 * - **Cost** is the attributed quantity at Cloudflare's list price (`CLOUDFLARE_LIST_RATES`),
 *   before the account's included allowances, as the #3316 measurement priced it.
 * - **Price** is cost × (1 + markup), the markup read from the schedule in force on each day
 *   (`priceCostRows`, `markup.ts`).
 * - A tenant sees the price only (`tenantPlatformUsage`). Staff see cost, markup and price side
 *   by side, plus what no tenant is charged for (`staffPlatformCosts`).
 *
 * Every figure is a decimal string computed with the contracts helpers, never a float.
 */
import { z } from 'zod';
import { costAttribution, costQuantity, utcDay, type CostDimension } from './control-plane.js';
import { instant, tenantId } from './ids.js';
import { billedDimension, usageKind, type BilledDimension } from './markup.js';
import { mulDivDecimal } from './money.js';

/** The billed dimensions platform usage reports: Cloudflare's, in the order a reader scans them. */
export const PLATFORM_USAGE_DIMENSIONS = [
  'rows-written',
  'rows-read',
  'storage',
  'requests',
  'cpu',
  'do-requests',
  'duration',
  'container-memory',
  'container-cpu',
  'container-disk',
  'container-egress',
] as const satisfies readonly BilledDimension[];
export type PlatformUsageDimension = (typeof PLATFORM_USAGE_DIMENSIONS)[number];

/**
 * One list rate: `usd` per `per` units of the dimension's quantity. Quantities are in the unit
 * `platformQuantityOf` reports: requests, CPU milliseconds, Durable Object requests, GB-seconds,
 * rows, and bytes stored on the day (storage is quoted per GB-month and charged per day, so a
 * day's storage costs `bytes × usd / (per × days in that month)`); for Containers, vCPU-seconds,
 * GiB-seconds, GB-seconds and bytes sent.
 */
export interface ListRate {
  dimension: PlatformUsageDimension;
  usd: string;
  per: number;
  unit: string;
}

/**
 * Cloudflare's list prices for Workers and SQLite-backed Durable Objects, dated like the markup
 * schedule: a change is a new entry with the UTC day it takes effect, so a past day keeps the
 * price it was billed at. The figures are the public price list, the ones #3316's first
 * measurement used.
 */
export const CLOUDFLARE_LIST_RATES: readonly { effectiveFrom: string; rates: readonly ListRate[] }[] = [
  {
    effectiveFrom: '2000-01-01',
    rates: [
      { dimension: 'requests', usd: '0.30', per: 1_000_000, unit: 'requests' },
      { dimension: 'cpu', usd: '0.02', per: 1_000_000, unit: 'CPU ms' },
      { dimension: 'do-requests', usd: '0.15', per: 1_000_000, unit: 'Durable Object requests' },
      { dimension: 'duration', usd: '12.50', per: 1_000_000, unit: 'GB-s' },
      { dimension: 'rows-read', usd: '0.001', per: 1_000_000, unit: 'rows read' },
      { dimension: 'rows-written', usd: '1.00', per: 1_000_000, unit: 'rows written' },
      { dimension: 'storage', usd: '0.20', per: 1_000_000_000, unit: 'bytes per month' },
      // Containers (#3316): $0.000020 per vCPU-s, $0.0000025 per GiB-s, $0.00000007 per GB-s, and
      // egress at the North America and Europe rate, $0.025 per GB, where the platform runs them.
      { dimension: 'container-cpu', usd: '20.00', per: 1_000_000, unit: 'container vCPU-s' },
      { dimension: 'container-memory', usd: '2.50', per: 1_000_000, unit: 'container GiB-s' },
      { dimension: 'container-disk', usd: '0.07', per: 1_000_000, unit: 'container disk GB-s' },
      { dimension: 'container-egress', usd: '0.025', per: 1_000_000_000, unit: 'container egress bytes' },
    ],
  },
];

/** The list rates in force on `day`, or none before the first entry. */
export function listRatesOn(day: string): readonly ListRate[] {
  let found: readonly ListRate[] = [];
  let from = '';
  for (const entry of CLOUDFLARE_LIST_RATES) {
    if (entry.effectiveFrom <= day && entry.effectiveFrom >= from) {
      found = entry.rates;
      from = entry.effectiveFrom;
    }
  }
  return found;
}

/**
 * The billed dimension each rollup dimension is charged as, or null for one Cloudflare does not
 * bill on SQLite-backed objects: their writes are billed as rows written, so the storage write
 * units the analytics also report would count them twice. The observability dimensions (#3358) are
 * null too, for another reason: not billed yet, said beside them.
 */
export const COST_DIMENSION_BILLED: Readonly<Record<CostDimension, PlatformUsageDimension | null>> = {
  worker_cpu_us: 'cpu',
  do_requests: 'do-requests',
  do_rows_read: 'rows-read',
  do_rows_written: 'rows-written',
  do_storage_write_units: null,
  do_duration_gb_s: 'duration',
  container_cpu_s: 'container-cpu',
  container_memory_gib_s: 'container-memory',
  container_disk_gb_s: 'container-disk',
  container_egress_bytes: 'container-egress',
  // #3358: measured and attributed, and NOT yet billed. Who pays for a listed app's lines (its
  // publisher, or the tenant that installed it) is a pricing decision still open, so these map to
  // no billed dimension until it is taken; the rows carry both the installing tenant and the vertical.
  log_events: null,
  log_bytes: null,
  span_events: null,
  span_bytes: null,
};

/** A rollup quantity in its billed unit: CPU µs become ms; every other unit is kept. */
export function platformQuantityOf(dimension: CostDimension, quantity: string): string {
  return dimension === 'worker_cpu_us' ? mulDivDecimal(quantity, '1', 1000) : quantity;
}

function daysInMonth(day: string): number {
  const [y, m] = day.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** A quantity's cost at list price on `day`, USD; null when no rate is in force for it. */
export function listCostOf(dimension: PlatformUsageDimension, quantity: string, day: string): string | null {
  const rate = listRatesOn(day).find((r) => r.dimension === dimension);
  if (!rate) return null;
  const per = dimension === 'storage' ? BigInt(rate.per) * BigInt(daysInMonth(day)) : rate.per;
  return mulDivDecimal(quantity, rate.usd, per);
}

const usd = costQuantity;

/** One figure per reported dimension, keyed by `QUANTITY_KEY`. */
function perDimension<T extends z.ZodTypeAny>(value: T) {
  return z.object({
    rowsWritten: value,
    rowsRead: value,
    storage: value,
    requests: value,
    cpu: value,
    doRequests: value,
    duration: value,
    containerMemory: value,
    containerCpu: value,
    containerDisk: value,
    containerEgress: value,
  });
}

/** The key each dimension's figure has in a quantities object: an identifier, so a generated client can name it bare. */
export const QUANTITY_KEY = {
  'rows-written': 'rowsWritten',
  'rows-read': 'rowsRead',
  storage: 'storage',
  requests: 'requests',
  cpu: 'cpu',
  'do-requests': 'doRequests',
  duration: 'duration',
  'container-memory': 'containerMemory',
  'container-cpu': 'containerCpu',
  'container-disk': 'containerDisk',
  'container-egress': 'containerEgress',
} as const satisfies Record<PlatformUsageDimension, string>;

/**
 * The quantities behind a figure, in each dimension's billed unit (`ListRate.unit`). `storage` is
 * bytes stored on a day; over several days it is their sum, byte-days, which a reader divides by
 * the days read for the average stored.
 */
export const platformQuantities = perDimension(costQuantity);
export type PlatformQuantities = z.infer<typeof platformQuantities>;

/**
 * What each dimension's quantities would cost at the platform's price, USD, keyed like
 * `platformQuantities`: the answer to "which usage made this day cost what it did". A price per
 * dimension, never a cost or a markup.
 */
export const platformPrices = perDimension(usd);
export type PlatformPrices = z.infer<typeof platformPrices>;

/**
 * How much of the window the cost rollup has read. `not-read`: no day yet (the daily pass has
 * not run, or has not reached these days), so an empty page says nothing about usage. `empty`:
 * days were read and the team used nothing on them. `partial`: some days are still unread.
 */
export const platformUsageState = z.enum(['not-read', 'empty', 'partial', 'complete']);
export type PlatformUsageState = z.infer<typeof platformUsageState>;

const coverage = {
  since: utcDay,
  until: utcDay,
  readAt: instant,
  state: platformUsageState,
  /** Days in the window the cost rollup has read. Only those are counted. */
  readDays: z.number().int().nonnegative(),
  totalDays: z.number().int().positive(),
  /** The latest successful read of a day in the window. */
  lastReadAt: instant.nullable(),
};

/** One app (a vertical, or none for usage that names none) of one kind. */
const appKey = { vertical: z.string().min(1).nullable(), kind: usageKind };

/**
 * `GET /tenants/:tenantId/platform-usage` (#3316): what the team's apps used of the platform,
 * per closed UTC day, and what it would cost at the platform's price. PRICE ONLY: neither the
 * platform's cost nor its markup is in this shape. Nothing is charged yet (`chargedUsd` is 0).
 */
export const tenantPlatformUsage = z.object({
  ...coverage,
  /** What the window would cost at the platform's price. */
  wouldCostUsd: usd,
  liveWouldCostUsd: usd,
  previewWouldCostUsd: usd,
  /** What is charged for it: nothing, while platform usage is shown before it is billed. */
  chargedUsd: z.literal('0'),
  quantities: platformQuantities,
  /** Per app and kind over the window, costliest first. */
  apps: z.array(
    z.object({
      ...appKey,
      wouldCostUsd: usd,
      quantities: platformQuantities,
    }),
  ),
  /** Every day of the window, oldest first. An unread day carries nulls, never zeros. */
  days: z.array(
    z.object({
      day: utcDay,
      read: z.boolean(),
      wouldCostUsd: usd.nullable(),
      liveWouldCostUsd: usd.nullable(),
      previewWouldCostUsd: usd.nullable(),
      quantities: platformQuantities.nullable(),
      /** The day's price per dimension; null on an unread day. */
      wouldCostByDimension: platformPrices.nullable(),
      /** Costliest first, each with its own price per dimension. */
      byApp: z.array(z.object({ ...appKey, wouldCostUsd: usd, wouldCostByDimension: platformPrices })),
    }),
  ),
  /** A source capped its rows, so request or storage figures are a lower bound. */
  truncated: z.boolean(),
});
export type TenantPlatformUsage = z.infer<typeof tenantPlatformUsage>;

/** Cost, markup (price − cost) and price side by side. Markup and price are null where no markup row is in force. */
const priced = {
  costUsd: usd,
  markupUsd: usd.nullable(),
  priceUsd: usd.nullable(),
  /** The part of `costUsd` that previews ran up. */
  previewCostUsd: usd,
};

/** What is in the rollup but charged to no tenant, by why (`costAttribution`). */
const residualSplit = {
  unmapped: usd,
  platform: usd,
  unknown: usd,
};

/**
 * `GET /meters/platform-costs` (#3316), staff only: per tenant and per day, the attributed cost,
 * the markup and the price; each tenant's costliest verticals and its preview share; and the
 * unattributed residual (`unmapped`, `platform`, `unknown`), which has a cost and no price.
 */
export const staffPlatformCosts = z.object({
  ...coverage,
  /** The cost rollup's record of each day in the window that it tried. */
  days: z.array(
    z.object({
      day: utcDay,
      read: z.boolean(),
      readAt: instant.nullable(),
      error: z.string().nullable(),
    }),
  ),
  /** The list rates in force on `until`, the basis of every cost here. */
  rates: z.array(z.object({ dimension: billedDimension, usd, per: z.number().int().positive(), unit: z.string() })),
  totals: z.object({ ...priced, residualCostUsd: usd }),
  /** Costliest first. */
  tenants: z.array(
    z.object({
      tenantId,
      ...priced,
      /** The tenant's costliest verticals over the window, at most five. */
      topVerticals: z.array(z.object({ vertical: z.string().min(1).nullable(), ...priced })),
      /** The days it used anything, oldest first. */
      days: z.array(z.object({ day: utcDay, ...priced })),
    }),
  ),
  residual: z.object({
    costUsd: usd,
    ...residualSplit,
    days: z.array(z.object({ day: utcDay, costUsd: usd, ...residualSplit })),
  }),
  /** A source capped its rows, so request or storage figures are a lower bound. */
  truncated: z.boolean(),
});
export type StaffPlatformCosts = z.infer<typeof staffPlatformCosts>;

/** Re-exported for the fold: the attributions a residual splits by. */
export const RESIDUAL_ATTRIBUTIONS = ['unmapped', 'platform', 'unknown'] as const satisfies readonly z.infer<typeof costAttribution>[];
