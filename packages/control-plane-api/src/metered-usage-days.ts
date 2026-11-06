/**
 * The day-by-day half of `GET /tenants/:tenantId/metered-usage`: what the Billing chart draws.
 *
 * A `null` is a fact here, as it is on the totals: no reading stands behind that day, which is
 * not the same as a day of no usage. Only a source that was read and covers the day answers `0`.
 */

/** One app's share of a day. `vertical` is null for traffic that names none. */
export interface UsageDayShare {
  vertical: string | null;
  value: number;
}

/** One closed UTC day. A share list can sum to less than its total: long labels stay out of it. */
export interface UsageDay {
  day: string;
  requests: number | null;
  requestsByVertical: UsageDayShare[];
  modelCalls: number | null;
  /** Input plus output tokens, as reported. Null on a day whose calls reported none. */
  tokens: number | null;
  tokensByVertical: UsageDayShare[];
  storedBytes: number | null;
  /** How many scopes have a sample that day, which is what a dip in `storedBytes` needs read beside it. */
  storedScopes: number;
}

export interface UsageDayRequests {
  rows: readonly { day: string; vertical: string | null; labelTruncated: boolean; requests: number }[];
  /** Days the rollup read and did not saturate. Every other day is unknown. */
  covered: ReadonlySet<string>;
  /** The rows stopped at a cap. They come oldest first, so the last day they reach is cut short. */
  clipped: boolean;
}

export interface UsageDayModels {
  /** `vertical` is null for a label too long to name, which keeps that call out of the shares. */
  rows: readonly { day: string; vertical: string | null; reported: boolean; tokens: number }[];
  /** The rows stopped at a cap. They come newest first, so the last day they reach is cut short. */
  truncated: boolean;
}

export interface UsageDayStorage {
  rows: readonly { day: string; bytes: number }[];
}

/** The most apps one day's share list names. The rest is what the list leaves of the total. */
const SHARES_PER_DAY = 50;

/** Every UTC day from `since` to `through`, both inclusive. */
export function utcDaysBetween(since: string, through: string): string[] {
  const days: string[] = [];
  const last = Date.parse(`${through}T00:00:00Z`);
  for (let at = Date.parse(`${since}T00:00:00Z`); at <= last; at += 86_400_000) {
    days.push(new Date(at).toISOString().slice(0, 10));
  }
  return days;
}

function sharesOf(values: Map<string | null, number> | undefined): UsageDayShare[] {
  if (!values) return [];
  return [...values]
    .sort((a, b) => b[1] - a[1] || (a[0] ?? '').localeCompare(b[0] ?? ''))
    .slice(0, SHARES_PER_DAY)
    .map(([vertical, value]) => ({ vertical, value }));
}

function addShare(byDay: Map<string, Map<string | null, number>>, day: string, vertical: string | null, value: number): void {
  const shares = byDay.get(day) ?? new Map<string | null, number>();
  shares.set(vertical, (shares.get(vertical) ?? 0) + value);
  byDay.set(day, shares);
}

/**
 * Fold what the route read into one row per day. A source that was not read is `null`, and every
 * day of it stays null. A capped read knows nothing about the day it stopped in or any day past
 * it, so those are null too rather than a low number on a bar.
 */
export function usageDays(
  days: readonly string[],
  sources: { requests: UsageDayRequests | null; models: UsageDayModels | null; storage: UsageDayStorage | null },
): UsageDay[] {
  const { requests, models, storage } = sources;

  const requestTotals = new Map<string, number>();
  const requestShares = new Map<string, Map<string | null, number>>();
  for (const row of requests?.rows ?? []) {
    requestTotals.set(row.day, (requestTotals.get(row.day) ?? 0) + row.requests);
    if (!row.labelTruncated) addShare(requestShares, row.day, row.vertical, row.requests);
  }
  const requestsEnd = requests?.clipped ? requests.rows[requests.rows.length - 1]?.day : undefined;

  const callTotals = new Map<string, number>();
  const reportedCalls = new Map<string, number>();
  const tokenTotals = new Map<string, number>();
  const tokenShares = new Map<string, Map<string | null, number>>();
  for (const row of models?.rows ?? []) {
    callTotals.set(row.day, (callTotals.get(row.day) ?? 0) + 1);
    if (!row.reported) continue;
    reportedCalls.set(row.day, (reportedCalls.get(row.day) ?? 0) + 1);
    tokenTotals.set(row.day, (tokenTotals.get(row.day) ?? 0) + row.tokens);
    if (row.vertical !== null) addShare(tokenShares, row.day, row.vertical, row.tokens);
  }
  const modelsEnd = models?.truncated ? models.rows[models.rows.length - 1]?.day : undefined;

  const storedTotals = new Map<string, number>();
  const storedScopes = new Map<string, number>();
  for (const row of storage?.rows ?? []) {
    storedTotals.set(row.day, (storedTotals.get(row.day) ?? 0) + row.bytes);
    storedScopes.set(row.day, (storedScopes.get(row.day) ?? 0) + 1);
  }

  return days.map((day) => {
    const requestsKnown = requests !== null && requests.covered.has(day) && (requestsEnd === undefined || day < requestsEnd);
    const modelsKnown = models !== null && (modelsEnd === undefined || day > modelsEnd);
    const calls = callTotals.get(day) ?? 0;
    return {
      day,
      requests: requestsKnown ? requestTotals.get(day) ?? 0 : null,
      requestsByVertical: requestsKnown ? sharesOf(requestShares.get(day)) : [],
      modelCalls: modelsKnown ? calls : null,
      tokens: !modelsKnown ? null : calls === 0 ? 0 : reportedCalls.has(day) ? tokenTotals.get(day) ?? 0 : null,
      tokensByVertical: modelsKnown ? sharesOf(tokenShares.get(day)) : [],
      storedBytes: storedTotals.get(day) ?? null,
      storedScopes: storedScopes.get(day) ?? 0,
    };
  });
}
