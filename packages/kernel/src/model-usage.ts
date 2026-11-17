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
  modelUsageSummary,
  mulDecimal,
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
 */
export interface ModelUsagePricing {
  zeroRatedScopes?: readonly string[];
}

/** `a - b` on the fold's decimal strings, exact: `addDecimal` with the sign of `b` turned. */
const subtractDecimal = (a: string, b: string): string => addDecimal(a, b.startsWith('-') ? b.slice(1) : b === '0' ? '0' : `-${b}`);

const EMPTY_TOTALS = { calls: 0, unpriced: 0, inputTokens: 0, outputTokens: 0, listUsd: '0', zeroRatedCalls: 0, zeroRatedListUsd: '0' };

export function foldModelUsage(
  entries: readonly ModelUsageEntry[],
  window: { readAt: string; since: string; until: string; marginPercent: number } & ModelUsagePricing,
): ModelUsageSummary {
  const factor = marginFactor(window.marginPercent);
  const zeroRated = new Set(window.zeroRatedScopes ?? []);
  const rows = new Map<string, ModelUsageSummaryRow>();
  // The zero-rated part of each row's list price, kept beside the row: the row carries what it would cost.
  const zeroRatedList = new Map<string, string>();
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
    const listUsd = e.listUsd === null ? row.listUsd : addDecimal(row.listUsd, e.listUsd);
    const free = zeroRated.has(e.attribution.scope);
    const freeList = free && e.listUsd !== null ? addDecimal(zeroRatedList.get(key) ?? '0', e.listUsd) : zeroRatedList.get(key) ?? '0';
    zeroRatedList.set(key, freeList);
    rows.set(key, {
      ...row,
      calls: row.calls + 1,
      unpriced: row.unpriced + (e.listUsd === null ? 1 : 0),
      inputTokens: row.inputTokens + e.inputTokens,
      outputTokens: row.outputTokens + e.outputTokens,
      cachedInputTokens: row.cachedInputTokens + e.cachedInputTokens,
      cacheWriteTokens: row.cacheWriteTokens + e.cacheWriteTokens,
      listUsd,
      billedUsd: mulDecimal(subtractDecimal(listUsd, freeList), factor),
      zeroRatedCalls: row.zeroRatedCalls + (free ? 1 : 0),
      zeroRatedUsd: mulDecimal(freeList, factor),
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
      ...t,
      calls: t.calls + r.calls,
      unpriced: t.unpriced + r.unpriced,
      inputTokens: t.inputTokens + r.inputTokens,
      outputTokens: t.outputTokens + r.outputTokens,
      listUsd: addDecimal(t.listUsd, r.listUsd),
      zeroRatedCalls: t.zeroRatedCalls + r.zeroRatedCalls,
      zeroRatedListUsd: addDecimal(t.zeroRatedListUsd, zeroRatedList.get(`${r.tenantId} ${r.vertical} ${r.model}`) ?? '0'),
    }),
    EMPTY_TOTALS,
  );
  const { zeroRatedListUsd, ...summed } = totals;
  return modelUsageSummary.parse({
    readAt: window.readAt,
    since: window.since,
    until: window.until,
    marginPercent: window.marginPercent,
    rows: sorted,
    totals: {
      ...summed,
      billedUsd: mulDecimal(subtractDecimal(totals.listUsd, zeroRatedListUsd), factor),
      zeroRatedUsd: mulDecimal(zeroRatedListUsd, factor),
    },
  });
}
