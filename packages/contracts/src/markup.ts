/**
 * The markup schedule (#3316, Pricing): what the platform charges over what a tenant's usage
 * costs it. One mechanism for every priced thing — Cloudflare's billed dimensions, model calls,
 * build time — so the builder's model markup and the ledger's are rows here, not constants.
 *
 * - **Data, not code.** A default plus overrides per tenant, per billed dimension and per kind
 *   (live or preview). The most specific row wins: a tenant row over a platform row, then a
 *   dimension row over a dimension-wide one, then a kind row over a kind-wide one
 *   (`MARKUP_PRECEDENCE`).
 * - **Dated, never edited.** A change is a new row with the UTC day it takes effect. A past day
 *   is priced at the row in force on that day, so a change never reprices history. A row with
 *   `percent: null` ends an override: that level falls through to the next less specific one,
 *   so a tenant once given its own rate is not frozen off every later change to the default.
 * - **Applied at read.** Cost is what is stored; price = cost × (1 + markup), computed here with
 *   `mulDecimal`/`marginFactor`, never floated and never stored.
 */
import { z } from 'zod';
import { utcDay } from './control-plane.js';
import { tenantId } from './ids.js';
import { marginFactor } from './model-usage.js';
import { mulDecimal } from './money.js';

/** The dimensions a tenant is billed on: Cloudflare's, plus model calls and build time. */
export const BILLED_DIMENSIONS = [
  'requests',
  'cpu',
  'do-requests',
  'duration',
  'rows-read',
  'rows-written',
  'storage',
  'model-calls',
  'build-time',
] as const;
export const billedDimension = z.enum(BILLED_DIMENSIONS);
export type BilledDimension = z.infer<typeof billedDimension>;

/** Live usage, or a preview's (a fork, a PR version). */
export const usageKind = z.enum(['live', 'preview']);
export type UsageKind = z.infer<typeof usageKind>;

/** The highest markup a row may carry, whole percent: 10× cost. A bound on a typo, not a policy. */
export const MARKUP_PERCENT_MAX = 1000;

const markupPercent = z.number().int().min(0).max(MARKUP_PERCENT_MAX);

/** The fields that name what a row applies to. `null` is "every": every tenant, dimension, kind. */
const markupTarget = {
  tenantId: tenantId.nullable(),
  dimension: billedDimension.nullable(),
  kind: usageKind.nullable(),
};

/** One row of the schedule, as stored. */
export const markupRow = z
  .object({
    id: z.string().min(1),
    ...markupTarget,
    /** The first UTC day the row prices. */
    effectiveFrom: utcDay,
    /** Whole percent over cost; `null` ends an override at this level (it falls through). */
    percent: markupPercent.nullable(),
    /** Why — the admin log carries who; this carries the decision. */
    reason: z.string().min(1).max(500),
    setAt: z.string().min(1),
    setBy: z.string().min(1),
  })
  .strict();
export type MarkupRow = z.infer<typeof markupRow>;

/**
 * What staff send to add a row. Omitted target fields mean "every". The platform default (no
 * target at all) must carry a percent: it is the floor every other row falls through to.
 */
export const markupRowInput = z
  .object({
    tenantId: tenantId.nullable().optional(),
    dimension: billedDimension.nullable().optional(),
    kind: usageKind.nullable().optional(),
    effectiveFrom: utcDay,
    percent: markupPercent.nullable(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict()
  .refine((r) => r.percent !== null || r.tenantId != null || r.dimension != null || r.kind != null, {
    message: 'the platform default must carry a percent',
    path: ['percent'],
  });
export type MarkupRowInput = z.infer<typeof markupRowInput>;

/** Who the seed rows name as their setter: the platform, not a person. */
export const MARKUP_SEED_ACTOR = 'platform-seed';
/** The day the seed rows take effect from: before any usage the platform holds, so every day it can price has a row. */
export const MARKUP_SEED_EFFECTIVE_FROM = '2000-01-01';

/**
 * The owner's decisions of 2026-11-21 on #3316: the rows every schedule holds beneath what staff
 * add. Read beneath the stored rows rather than inserted (the kernel's `markupScheduleOf`), with
 * fixed ids, so a later row supersedes them and none can be lost or duplicated by a restore.
 */
export const MARKUP_SEED: readonly MarkupRow[] = [
  {
    id: '01KAKX00000000000000MARK01',
    tenantId: null,
    dimension: null,
    kind: null,
    effectiveFrom: MARKUP_SEED_EFFECTIVE_FROM,
    percent: 100,
    reason: 'Default markup over attributed cost, owner decision 2026-11-21 (#3316).',
    setAt: '2026-11-21T00:00:00.000Z',
    setBy: MARKUP_SEED_ACTOR,
  },
  {
    id: '01KAKX00000000000000MARK02',
    tenantId: null,
    dimension: null,
    kind: 'preview',
    effectiveFrom: MARKUP_SEED_EFFECTIVE_FROM,
    percent: 0,
    reason: 'Previews are priced at cost, owner decision 2026-11-21 (#3316).',
    setAt: '2026-11-21T00:00:00.000Z',
    setBy: MARKUP_SEED_ACTOR,
  },
  {
    id: '01KAKX00000000000000MARK03',
    tenantId: null,
    dimension: 'model-calls',
    kind: null,
    effectiveFrom: MARKUP_SEED_EFFECTIVE_FROM,
    percent: 30,
    reason: 'Model usage markup, owner decision 2026-11-21 (#3316); the builder studio and the model ledger both price at it.',
    setAt: '2026-11-21T00:00:00.000Z',
    setBy: MARKUP_SEED_ACTOR,
  },
];

/** What a price is asked for: whose usage, on what, of which kind, on which UTC day. */
export interface MarkupQuery {
  /** Null asks for the platform's rate, ignoring every tenant row. */
  tenantId: string | null;
  dimension: BilledDimension;
  kind: UsageKind;
  day: string;
}

type Level = readonly [tenant: boolean, dimension: boolean, kind: boolean];

/**
 * The order rows are tried in, most specific first: tenant, then dimension, then kind. So a
 * tenant's own rate beats every platform row, and a dimension's rate beats a kind's (a model
 * call made by a preview is priced as a model call).
 */
export const MARKUP_PRECEDENCE: readonly Level[] = [
  [true, true, true],
  [true, true, false],
  [true, false, true],
  [true, false, false],
  [false, true, true],
  [false, true, false],
  [false, false, true],
  [false, false, false],
];

const levelOf = (r: Pick<MarkupRow, 'tenantId' | 'dimension' | 'kind'>): string =>
  `${r.tenantId !== null}${r.dimension !== null}${r.kind !== null}`;

/** Later wins: the later effective day, then the later setting, then the later id. */
const later = (a: MarkupRow, b: MarkupRow): boolean =>
  a.effectiveFrom !== b.effectiveFrom
    ? a.effectiveFrom > b.effectiveFrom
    : a.setAt !== b.setAt
      ? a.setAt > b.setAt
      : a.id > b.id;

/**
 * The row in force for one query, or null when the schedule holds none (a price is then unknown,
 * never guessed). At each level the latest row in force on `day` decides; a `null` percent there
 * passes the question to the next level.
 */
export function markupInForce(schedule: readonly MarkupRow[], query: MarkupQuery): MarkupRow | null {
  const latest = new Map<string, MarkupRow>();
  for (const row of schedule) {
    if (row.effectiveFrom > query.day) continue;
    if (row.tenantId !== null && row.tenantId !== query.tenantId) continue;
    if (row.dimension !== null && row.dimension !== query.dimension) continue;
    if (row.kind !== null && row.kind !== query.kind) continue;
    const level = levelOf(row);
    const held = latest.get(level);
    if (!held || later(row, held)) latest.set(level, row);
  }
  for (const level of MARKUP_PRECEDENCE) {
    const row = latest.get(`${level[0]}${level[1]}${level[2]}`);
    if (row && row.percent !== null) return row;
  }
  return null;
}

/** The percent in force for one query, or null when no row covers it. */
export function markupPercentFor(schedule: readonly MarkupRow[], query: MarkupQuery): number | null {
  return markupInForce(schedule, query)?.percent ?? null;
}

/** cost × (1 + percent/100), exact to the decimal scale. */
export function priceOf(costUsd: string, percent: number): string {
  return mulDecimal(costUsd, marginFactor(percent));
}

/**
 * One day's attributed cost on one billed dimension, as the daily cost rollup (#3316) holds it.
 * Deliberately narrow: the rollup's own row carries more (vertical, scope, confidence), and
 * pricing needs only these.
 */
export interface DailyCostRow {
  day: string;
  tenantId: string;
  dimension: BilledDimension;
  kind: UsageKind;
  /** List-price cost, USD decimal string. */
  costUsd: string;
}

/** What staff see: cost, markup and price side by side. Null markup and price: no row in force. */
export interface StaffPricedRow extends DailyCostRow {
  markupPercent: number | null;
  priceUsd: string | null;
}

/** What a tenant sees: the price, with neither the cost nor the markup behind it. */
export interface TenantPricedRow {
  day: string;
  dimension: BilledDimension;
  kind: UsageKind;
  priceUsd: string | null;
}

/** Price cost rows for staff, each at the markup in force on its own day. */
export function priceCostRows(rows: readonly DailyCostRow[], schedule: readonly MarkupRow[]): StaffPricedRow[] {
  return rows.map((row) => {
    const percent = markupPercentFor(schedule, row);
    return { ...row, markupPercent: percent, priceUsd: percent === null ? null : priceOf(row.costUsd, percent) };
  });
}

/** Price cost rows for the tenant: the price only. */
export function tenantPricedRows(rows: readonly DailyCostRow[], schedule: readonly MarkupRow[]): TenantPricedRow[] {
  return priceCostRows(rows, schedule).map(({ day, dimension, kind, priceUsd }) => ({ day, dimension, kind, priceUsd }));
}
