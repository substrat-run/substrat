/**
 * Meter 3's fold — model usage, summarised the one way (#1054).
 *
 * The rule lives here, not in either adapter, for the reason `foldMeterReading` does:
 * a billable number must have ONE definition, and an adapter that summed in SQL would
 * float the money. Adapters list the rows in a window; this folds them.
 */
import {
  addDecimal,
  marginFactor,
  markupPercentFor,
  modelUsageSummary,
  mulDecimal,
  type MarkupRow,
  type ModelUsageEntry,
  type ModelUsageLine,
  type ModelUsageSummary,
  type ModelUsageSummaryRow,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';

/**
 * How long a line stays in the directory. Thirteen months — a year of usage plus the
 * month being billed — because this ledger IS what an invoice reconciles against, and
 * a reconciliation older than that is an audit, which reads the invoice.
 */
export const MODEL_USAGE_RETENTION_DAYS = 400;

/** What the drain hands `recordModelUsage`. `id` is stamped by the adapter. */
export interface ModelUsageInput {
  /** The intent's id — the dedupe key. A second record under the same id writes nothing. */
  requestId: string;
  line: ModelUsageLine;
}

/** Filter for `listModelUsage` — cursor/order/limit exactly as `OpsFailureFilter`. */
export interface ModelUsageFilter {
  tenantId?: TenantId;
  scopeId?: ScopeId;
  vertical?: string;
  /** Normalized `provider:modelId`. */
  model?: string;
  since?: string;
  until?: string;
  limit?: number;
  cursor?: string;
  /** Default 'desc' — an operator asks "what ran lately". */
  order?: 'asc' | 'desc';
}

/** Narrow, bounded tenant meter projection; labels longer than the projection caps are omitted from breakdowns. */
export interface TenantModelUsageMeterRow {
  id: string;
  at: string;
  vertical: string;
  model: string;
  labelTruncated: boolean;
  reported: boolean;
  inputTokens: number;
  outputTokens: number;
}

export interface TenantModelUsageMeterFilter {
  tenantId: TenantId;
  since: string;
  until: string;
  limit: number;
  cursor?: { at: string; id: string };
}

/** The window `summarizeModelUsage` folds: half-open `[since, until)`, one tenant or the fleet. */
export interface ModelUsageWindow {
  tenantId?: TenantId;
  since: string;
  until: string;
}

/**
 * How a read prices what it folds, beyond the margin. `zeroRatedScopes`: lines filed under one of
 * these scopes are priced at zero, with what they would cost shown beside (#2365: a code review is
 * filed under the platform's review scope, and reviews are zero-rated until the runner's phase 3).
 * Which scopes, and for how long, is the caller's policy; the fold only applies it.
 *
 * `markup` (#3316): the markup schedule. Each line is then priced at the `model-calls` row in
 * force for its tenant on its own UTC day, so a tenant's override and a dated change both apply,
 * and `marginPercent` is only the rate for a line no row covers. A model line is read as `live`:
 * the ledger cannot tell a preview's call from a live one, and the dimension row outranks a kind
 * row anyway (`MARKUP_PRECEDENCE`).
 */
export interface ModelUsagePricing {
  zeroRatedScopes?: readonly string[];
  markup?: readonly MarkupRow[];
}

/** `a - b` on the fold's decimal strings, exact: `addDecimal` with the sign of `b` turned. */
const subtractDecimal = (a: string, b: string): string => addDecimal(a, b.startsWith('-') ? b.slice(1) : b === '0' ? '0' : `-${b}`);

const EMPTY_TOTALS = { calls: 0, unpriced: 0, inputTokens: 0, outputTokens: 0, listUsd: '0', zeroRatedCalls: 0 };

/**
 * List price kept apart per markup percent: the margin is multiplied once per percent, never per
 * line, so a window priced at one rate rounds exactly as a single `list × factor` does.
 */
type ByPercent = Map<number, { list: string; free: string }>;

const addTo = (groups: ByPercent, percent: number, list: string, free: boolean): void => {
  const g = groups.get(percent) ?? { list: '0', free: '0' };
  groups.set(percent, { list: addDecimal(g.list, list), free: free ? addDecimal(g.free, list) : g.free });
};

/** `billedUsd` (the charged part) and `zeroRatedUsd` (what the free part would cost) of a group set. */
const priceGroups = (groups: ByPercent): { billedUsd: string; zeroRatedUsd: string } => {
  let billedUsd = '0';
  let zeroRatedUsd = '0';
  for (const [percent, g] of groups) {
    const factor = marginFactor(percent);
    billedUsd = addDecimal(billedUsd, mulDecimal(subtractDecimal(g.list, g.free), factor));
    zeroRatedUsd = addDecimal(zeroRatedUsd, mulDecimal(g.free, factor));
  }
  return { billedUsd, zeroRatedUsd };
};

export function foldModelUsage(
  entries: readonly ModelUsageEntry[],
  window: { readAt: string; since: string; until: string; marginPercent: number } & ModelUsagePricing,
): ModelUsageSummary {
  marginFactor(window.marginPercent); // refuses a bad fallback rate even when no line needs it
  const zeroRated = new Set(window.zeroRatedScopes ?? []);
  const percentOf = (e: ModelUsageEntry): number =>
    (window.markup &&
      markupPercentFor(window.markup, {
        tenantId: e.attribution.tenant,
        dimension: 'model-calls',
        kind: 'live',
        day: e.at.slice(0, 10),
      })) ??
    window.marginPercent;
  const rows = new Map<string, ModelUsageSummaryRow>();
  const rowGroups = new Map<string, ByPercent>();
  const totalGroups: ByPercent = new Map();
  for (const e of entries) {
    const key = `${e.attribution.tenant} ${e.attribution.vertical} ${e.model}`;
    const row: ModelUsageSummaryRow = rows.get(key) ?? {
      tenantId: e.attribution.tenant,
      vertical: e.attribution.vertical,
      model: e.model,
      provider: e.provider,
      modelId: e.modelId,
      calls: 0,
      unpriced: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      listUsd: '0',
      billedUsd: '0',
      zeroRatedCalls: 0,
      zeroRatedUsd: '0',
    };
    const free = zeroRated.has(e.attribution.scope);
    const groups = rowGroups.get(key) ?? new Map();
    rowGroups.set(key, groups);
    if (e.listUsd !== null) {
      const percent = percentOf(e);
      addTo(groups, percent, e.listUsd, free);
      addTo(totalGroups, percent, e.listUsd, free);
    }
    rows.set(key, {
      ...row,
      calls: row.calls + 1,
      unpriced: row.unpriced + (e.listUsd === null ? 1 : 0),
      inputTokens: row.inputTokens + e.inputTokens,
      outputTokens: row.outputTokens + e.outputTokens,
      cachedInputTokens: row.cachedInputTokens + e.cachedInputTokens,
      cacheWriteTokens: row.cacheWriteTokens + e.cacheWriteTokens,
      listUsd: e.listUsd === null ? row.listUsd : addDecimal(row.listUsd, e.listUsd),
      ...priceGroups(groups),
      zeroRatedCalls: row.zeroRatedCalls + (free ? 1 : 0),
    });
  }
  const sorted = [...rows.values()].sort(
    (a, b) =>
      a.tenantId.localeCompare(b.tenantId) ||
      a.vertical.localeCompare(b.vertical) ||
      a.model.localeCompare(b.model),
  );
  const totals = sorted.reduce(
    (t, r) => ({
      calls: t.calls + r.calls,
      unpriced: t.unpriced + r.unpriced,
      inputTokens: t.inputTokens + r.inputTokens,
      outputTokens: t.outputTokens + r.outputTokens,
      listUsd: addDecimal(t.listUsd, r.listUsd),
      zeroRatedCalls: t.zeroRatedCalls + r.zeroRatedCalls,
    }),
    EMPTY_TOTALS,
  );
  return modelUsageSummary.parse({
    readAt: window.readAt,
    since: window.since,
    until: window.until,
    marginPercent: window.marginPercent,
    rows: sorted,
    totals: { ...totals, ...priceGroups(totalGroups) },
  });
}
