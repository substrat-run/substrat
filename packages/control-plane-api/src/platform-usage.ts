/**
 * The priced platform-usage reads (#3316), folded from what the directory stores:
 *
 * - the daily Cloudflare cost rollup, summed per group by the host (`sumCostDays`);
 * - router requests from the request rollup (#2501), per scope;
 * - storage from the stored gauge's daily samples (#1524), per scope.
 *
 * A day counts only once the cost rollup has read it: before that its rows say nothing, and a
 * request or storage figure on its own would read as the whole day. Requests and storage are
 * split by kind through the scopes the cost rows name; a scope no cost row names counts as live.
 * A request keeps the vertical the router resolved for it (the request rollup's own column),
 * falling back to the scope's; stored bytes take the scope's vertical, or none.
 *
 * Cost is list price (`listCostOf`); price is cost × (1 + markup), each line at the markup in
 * force for its tenant, dimension and kind on its own day (`priceCostRows`). The tenant fold
 * returns prices only. Everything is a decimal string; nothing is floated.
 */
import {
  COST_DIMENSION_BILLED,
  PLATFORM_USAGE_DIMENSIONS,
  QUANTITY_KEY,
  addDecimal,
  compareDecimal,
  listCostOf,
  listRatesOn,
  platformQuantityOf,
  priceCostRows,
  type CostAttribution,
  type MarkupRow,
  type PlatformQuantities,
  type PlatformUsageDimension,
  type PlatformUsageState,
  type RequestRollupDay,
  type staffPlatformCosts,
  type tenantPlatformUsage,
  type UsageKind,
  type z,
} from '@substrat-run/contracts';
import type { CostDayTotals } from '@substrat-run/kernel';
import { utcDaysBetween } from './metered-usage-days.js';

/** What the folds return: the readings' input side, which the routes parse into the published shape. */
type TenantPlatformUsage = z.input<typeof tenantPlatformUsage>;
type StaffPlatformCosts = z.input<typeof staffPlatformCosts>;

/** The most closed days one read covers: the analytics' 90 days, and a little of the backfill beyond. */
export const PLATFORM_USAGE_DAYS_MAX = 92;
/** How many verticals a tenant's staff row names. */
const TOP_VERTICALS = 5;

export interface PlatformUsageInputs {
  since: string;
  until: string;
  readAt: string;
  costs: CostDayTotals;
  /** The cost rollup's day ledger over the window. */
  reads: readonly RequestRollupDay[];
  requests: { rows: readonly { day: string; tenantId: string; vertical: string | null; scopeId: string; requests: number }[]; truncated: boolean };
  storage: { rows: readonly { day: string; tenantId: string; scopeId: string; bytes: number }[]; truncated: boolean };
  schedule: readonly MarkupRow[];
}

/** One (day, tenant, attribution, vertical, kind, dimension) group, costed. */
interface Line {
  day: string;
  tenantId: string | null;
  attribution: CostAttribution;
  vertical: string | null;
  kind: UsageKind;
  dimension: PlatformUsageDimension;
  quantity: string;
  costUsd: string;
}

const sub = (a: string, b: string): string => addDecimal(a, `-${b}`);
const sum = (values: Iterable<string>): string => {
  let total = '0';
  for (const v of values) total = addDecimal(total, v);
  return total;
};
const byCostDesc = <T>(cost: (t: T) => string) => (a: T, b: T) => compareDecimal(cost(b), cost(a));

function zeroQuantities(): PlatformQuantities {
  return Object.fromEntries(PLATFORM_USAGE_DIMENSIONS.map((d) => [QUANTITY_KEY[d], '0'])) as PlatformQuantities;
}

function addQuantity(into: PlatformQuantities, line: Pick<Line, 'dimension' | 'quantity'>): void {
  const key = QUANTITY_KEY[line.dimension];
  into[key] = addDecimal(into[key], line.quantity);
}

/** The window's days that the cost rollup has read, and the coverage the readings report. */
function coverageOf(inputs: PlatformUsageInputs, hasUsage: boolean) {
  const days = utcDaysBetween(inputs.since, inputs.until);
  const read = new Map(inputs.reads.filter((r) => r.readAt !== null).map((r) => [r.day, r.readAt!]));
  const readDays = days.filter((d) => read.has(d)).length;
  const state: PlatformUsageState = readDays === 0 ? 'not-read' : !hasUsage ? 'empty' : readDays < days.length ? 'partial' : 'complete';
  const lastReadAt = [...read.values()].reduce<string | null>((l, at) => (l === null || at > l ? at : l), null);
  return { days, read, coverage: { since: inputs.since, until: inputs.until, readAt: inputs.readAt, state, readDays, totalDays: days.length, lastReadAt } };
}

/** Every group of the window, costed, on the days the cost rollup has read. */
export function platformLines(inputs: PlatformUsageInputs, readDays: ReadonlySet<string>): Line[] {
  const quantities = new Map<string, Omit<Line, 'costUsd'>>();
  const add = (line: Omit<Line, 'costUsd'>) => {
    if (!readDays.has(line.day)) return;
    const key = JSON.stringify([line.day, line.tenantId, line.attribution, line.vertical, line.kind, line.dimension]);
    const held = quantities.get(key);
    if (held) held.quantity = addDecimal(held.quantity, line.quantity);
    else quantities.set(key, { ...line });
  };
  for (const t of inputs.costs.totals) {
    const dimension = COST_DIMENSION_BILLED[t.dimension];
    if (dimension === null) continue;
    add({ day: t.day, tenantId: t.tenantId, attribution: t.attribution, vertical: t.vertical, kind: t.kind, dimension, quantity: platformQuantityOf(t.dimension, t.quantity) });
  }
  const scopes = new Map(inputs.costs.scopes.map((s) => [s.scopeId, s]));
  for (const r of inputs.requests.rows) {
    if (r.requests === 0) continue;
    const scope = scopes.get(r.scopeId);
    add({ day: r.day, tenantId: r.tenantId, attribution: 'scope', vertical: r.vertical ?? scope?.vertical ?? null, kind: scope?.kind ?? 'live', dimension: 'requests', quantity: String(r.requests) });
  }
  for (const r of inputs.storage.rows) {
    if (r.bytes === 0) continue;
    const scope = scopes.get(r.scopeId);
    add({ day: r.day, tenantId: r.tenantId, attribution: 'scope', vertical: scope?.vertical ?? null, kind: scope?.kind ?? 'live', dimension: 'storage', quantity: String(r.bytes) });
  }
  return [...quantities.values()].map((l) => ({ ...l, costUsd: listCostOf(l.dimension, l.quantity, l.day) ?? '0' }));
}

interface PricedLine extends Line {
  priceUsd: string | null;
}

/** Each tenant's line priced at the markup in force for it on its day. A line with no tenant has no price. */
function priced(lines: readonly Line[], schedule: readonly MarkupRow[]): PricedLine[] {
  return lines.map((line) => {
    if (line.tenantId === null) return { ...line, priceUsd: null };
    const [p] = priceCostRows([{ day: line.day, tenantId: line.tenantId, dimension: line.dimension, kind: line.kind, costUsd: line.costUsd }], schedule);
    return { ...line, priceUsd: p!.priceUsd };
  });
}

/**
 * The tenant's reading: what its apps used and would cost at the platform's price, per day, by
 * app and kind. Only `wouldCostUsd` figures leave here, never a cost or a markup. A line the
 * schedule has no row for (it always has the platform default) is counted at no price.
 */
export function foldTenantPlatformUsage(inputs: PlatformUsageInputs, tenantId: string): TenantPlatformUsage {
  const reads = new Set(inputs.reads.filter((r) => r.readAt !== null).map((r) => r.day));
  const lines = priced(
    platformLines(inputs, reads).filter((l) => l.tenantId === tenantId),
    inputs.schedule,
  );
  const { days, coverage } = coverageOf(inputs, lines.length > 0);
  const price = (l: PricedLine) => l.priceUsd ?? '0';

  const quantities = zeroQuantities();
  const apps = new Map<string, { vertical: string | null; kind: UsageKind; wouldCostUsd: string; quantities: PlatformQuantities }>();
  for (const l of lines) {
    addQuantity(quantities, l);
    const key = JSON.stringify([l.vertical, l.kind]);
    const app = apps.get(key) ?? { vertical: l.vertical, kind: l.kind, wouldCostUsd: '0', quantities: zeroQuantities() };
    app.wouldCostUsd = addDecimal(app.wouldCostUsd, price(l));
    addQuantity(app.quantities, l);
    apps.set(key, app);
  }
  const ofKind = (kind: UsageKind, of: readonly PricedLine[]) => sum(of.filter((l) => l.kind === kind).map(price));
  return {
    ...coverage,
    wouldCostUsd: sum(lines.map(price)),
    liveWouldCostUsd: ofKind('live', lines),
    previewWouldCostUsd: ofKind('preview', lines),
    chargedUsd: '0',
    quantities,
    apps: [...apps.values()].sort(byCostDesc((a) => a.wouldCostUsd)),
    days: days.map((day) => {
      if (!reads.has(day)) {
        return { day, read: false, wouldCostUsd: null, liveWouldCostUsd: null, previewWouldCostUsd: null, quantities: null, byApp: [] };
      }
      const own = lines.filter((l) => l.day === day);
      const q = zeroQuantities();
      const byApp = new Map<string, { vertical: string | null; kind: UsageKind; wouldCostUsd: string }>();
      for (const l of own) {
        addQuantity(q, l);
        const key = JSON.stringify([l.vertical, l.kind]);
        const app = byApp.get(key) ?? { vertical: l.vertical, kind: l.kind, wouldCostUsd: '0' };
        app.wouldCostUsd = addDecimal(app.wouldCostUsd, price(l));
        byApp.set(key, app);
      }
      return {
        day,
        read: true,
        wouldCostUsd: sum(own.map(price)),
        liveWouldCostUsd: ofKind('live', own),
        previewWouldCostUsd: ofKind('preview', own),
        quantities: q,
        byApp: [...byApp.values()].sort(byCostDesc((a) => a.wouldCostUsd)),
      };
    }),
    truncated: inputs.requests.truncated || inputs.storage.truncated,
  };
}

interface Priced {
  costUsd: string;
  markupUsd: string | null;
  priceUsd: string | null;
  previewCostUsd: string;
}

/** Cost, markup and price over some lines. Price and markup are null when any line has no price. */
function pricedOf(lines: readonly PricedLine[]): Priced {
  const costUsd = sum(lines.map((l) => l.costUsd));
  const unpriced = lines.some((l) => l.priceUsd === null);
  const priceUsd = unpriced ? null : sum(lines.map((l) => l.priceUsd!));
  return {
    costUsd,
    markupUsd: priceUsd === null ? null : sub(priceUsd, costUsd),
    priceUsd,
    previewCostUsd: sum(lines.filter((l) => l.kind === 'preview').map((l) => l.costUsd)),
  };
}

function groupBy<T, K>(items: readonly T[], key: (t: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const held = groups.get(k);
    if (held) held.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}

/** A residual line's bucket: why no tenant is charged for it. */
const residualOf = (l: Line): 'unmapped' | 'platform' | 'unknown' =>
  l.attribution === 'unmapped' || l.attribution === 'platform' ? l.attribution : 'unknown';

function residualSplit(lines: readonly Line[]) {
  return {
    unmapped: sum(lines.filter((l) => residualOf(l) === 'unmapped').map((l) => l.costUsd)),
    platform: sum(lines.filter((l) => residualOf(l) === 'platform').map((l) => l.costUsd)),
    unknown: sum(lines.filter((l) => residualOf(l) === 'unknown').map((l) => l.costUsd)),
  };
}

/** The staff reading: per tenant and day, cost, markup and price, plus the unattributed residual. */
export function foldStaffPlatformCosts(inputs: PlatformUsageInputs): StaffPlatformCosts {
  const reads = new Set(inputs.reads.filter((r) => r.readAt !== null).map((r) => r.day));
  const all = priced(platformLines(inputs, reads), inputs.schedule);
  const { days, coverage } = coverageOf(inputs, all.length > 0);
  const attributed = all.filter((l) => l.tenantId !== null);
  const residual = all.filter((l) => l.tenantId === null);
  const ledger = new Map(inputs.reads.map((r) => [r.day, r]));

  const tenants = [...groupBy(attributed, (l) => l.tenantId!)].map(([tenantId, lines]) => ({
    tenantId,
    ...pricedOf(lines),
    topVerticals: [...groupBy(lines, (l) => l.vertical)]
      .map(([vertical, of]) => ({ vertical, ...pricedOf(of) }))
      .sort(byCostDesc((v) => v.costUsd))
      .slice(0, TOP_VERTICALS),
    days: [...groupBy(lines, (l) => l.day)].map(([day, of]) => ({ day, ...pricedOf(of) })).sort((a, b) => a.day.localeCompare(b.day)),
  }));
  tenants.sort(byCostDesc((t) => t.costUsd));

  return {
    ...coverage,
    days: days.map((day) => {
      const r = ledger.get(day);
      return { day, read: r?.readAt != null, readAt: r?.readAt ?? null, error: r?.error ?? null };
    }),
    rates: listRatesOn(inputs.until).map((r) => ({ ...r })),
    totals: { ...pricedOf(attributed), residualCostUsd: sum(residual.map((l) => l.costUsd)) },
    tenants,
    residual: {
      costUsd: sum(residual.map((l) => l.costUsd)),
      ...residualSplit(residual),
      days: [...groupBy(residual, (l) => l.day)].map(([day, of]) => ({ day, costUsd: sum(of.map((l) => l.costUsd)), ...residualSplit(of) })).sort((a, b) => a.day.localeCompare(b.day)),
    },
    truncated: inputs.requests.truncated || inputs.storage.truncated,
  };
}
