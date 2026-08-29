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

/** The window `summarizeModelUsage` folds: half-open `[since, until)`, one tenant or the fleet. */
export interface ModelUsageWindow {
  tenantId?: TenantId;
  since: string;
  until: string;
}

const EMPTY_TOTALS = { calls: 0, unpriced: 0, inputTokens: 0, outputTokens: 0, listUsd: '0', billedUsd: '0' };

export function foldModelUsage(
  entries: readonly ModelUsageEntry[],
  window: { readAt: string; since: string; until: string; marginPercent: number },
): ModelUsageSummary {
  const factor = marginFactor(window.marginPercent);
  const rows = new Map<string, ModelUsageSummaryRow>();
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
    };
    const listUsd = e.listUsd === null ? row.listUsd : addDecimal(row.listUsd, e.listUsd);
    rows.set(key, {
      ...row,
      calls: row.calls + 1,
      unpriced: row.unpriced + (e.listUsd === null ? 1 : 0),
      inputTokens: row.inputTokens + e.inputTokens,
      outputTokens: row.outputTokens + e.outputTokens,
      cachedInputTokens: row.cachedInputTokens + e.cachedInputTokens,
      cacheWriteTokens: row.cacheWriteTokens + e.cacheWriteTokens,
      listUsd,
      billedUsd: mulDecimal(listUsd, factor),
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
    }),
    EMPTY_TOTALS,
  );
  return modelUsageSummary.parse({
    readAt: window.readAt,
    since: window.since,
    until: window.until,
    marginPercent: window.marginPercent,
    rows: sorted,
    totals: { ...totals, billedUsd: mulDecimal(totals.listUsd, factor) },
  });
}
