import { addDecimal, moneyOf, type Money } from '@substrat-run/contracts';
import type { FortnoxFinancialYear } from './api.js';
import type { SieLedger } from './sie4.js';

/**
 * The cost-centre dimension. SIE reserves dimension `1` for kostnadsställe, and
 * Fortnox follows the standard — so a per-property or per-unit breakdown needs no
 * extra API call and no server-side filtering, only this constant.
 */
export const COST_CENTRE_DIMENSION = '1';

/** One summed cell: an account, a cost centre, and a month. */
export interface LedgerBalance {
  account: string;
  /** The dimension-1 object code, or `null` for rows booked without one. */
  costCentre: string | null;
  /** `YYYY-MM`. */
  month: string;
  /** Debit-positive, exactly as SIE stated it — see {@link SieLedger}. */
  amount: Money;
}

/** What {@link summarizeLedger} produces: the sums plus the labels to render them. */
export interface LedgerSummary {
  currency: string;
  balances: LedgerBalance[];
  /** Only the accounts that actually carry a balance, with their `#KONTO` names. */
  accounts: { number: string; name: string }[];
  /** Only the dimension-1 objects that actually appear, with their `#OBJEKT` names. */
  costCentres: { code: string; name: string }[];
  /** Rows skipped because their date fell outside the requested window. */
  outOfRange: number;
}

/**
 * Pick the financial year to export for a given period.
 *
 * **Overlap, not containment** — this is the PDF's trap, and it is a real one. A
 * newly-acquired company's first financial year can start mid-month (24 April, say),
 * so a search for "the year containing 1 January" finds nothing and the sync reports
 * an empty ledger for a company that has a full year of bookkeeping. Asking instead
 * for the year that *overlaps* the period always finds it.
 *
 * Ties are broken toward the later year: when a period spans a year boundary, the
 * newer year is the one still being posted to.
 */
export function financialYearFor(
  years: readonly FortnoxFinancialYear[],
  period: { from: string; to: string },
): FortnoxFinancialYear | null {
  const overlapping = years.filter((y) => y.FromDate <= period.to && y.ToDate >= period.from);
  if (overlapping.length === 0) return null;
  return overlapping.sort((a, b) => (a.FromDate < b.FromDate ? 1 : -1))[0]!;
}

/**
 * Sum a parsed ledger per (account, cost centre, month).
 *
 * Exact decimal arithmetic throughout (`addDecimal` over micro-units), never floats:
 * a ledger summed with `+=` on JavaScript numbers drifts by öre over a year of
 * vouchers, and an accounting figure that is nearly right is worse than one that is
 * obviously missing.
 *
 * The window is inclusive on both ends and filters on the TRANSACTION's date, which
 * is the voucher's unless a row overrode it — so a voucher straddling a month
 * boundary lands its rows in the months they belong to.
 */
export function summarizeLedger(
  ledger: SieLedger,
  window?: { from: string; to: string },
): LedgerSummary {
  const sums = new Map<
    string,
    { account: string; costCentre: string | null; month: string; amount: string }
  >();
  const seenAccounts = new Set<string>();
  const seenCentres = new Set<string>();
  let outOfRange = 0;

  for (const voucher of ledger.vouchers) {
    for (const t of voucher.transactions) {
      if (t.account === '') continue;
      const date = t.date === '' ? voucher.date : t.date;
      if (window && (date < window.from || date > window.to)) {
        outOfRange += 1;
        continue;
      }
      const month = date.slice(0, 7);
      if (month === '') continue;
      const costCentre = t.objects[COST_CENTRE_DIMENSION] ?? null;
      // NUL as the delimiter, because SIE cannot carry one in a field. A space could:
      // `#OBJEKT` codes are quoted free text, so `{"1" "KV 1"}` is legal, and joining on
      // spaces lets two distinct (account, cost centre, month) triples produce one key —
      // silently summing two unrelated balances into a single cell.
      const key = `${t.account}\u0000${costCentre ?? ''}\u0000${month}`;
      const existing = sums.get(key);
      // Seeded through `addDecimal` rather than stored raw, so a cell with ONE
      // transaction is as canonical as a cell with two. `t.amount` is whatever the file
      // said; `moneyOf` below demands `moneyAmount`'s shape, and a >6dp value satisfies
      // the first and not the second — so a single-row cell was the one path that could
      // reach `moneyOf` unnormalized.
      if (existing) existing.amount = addDecimal(existing.amount, t.amount);
      else sums.set(key, { account: t.account, costCentre, month, amount: addDecimal('0', t.amount) });
      seenAccounts.add(t.account);
      if (costCentre !== null) seenCentres.add(costCentre);
    }
  }

  const accountNames = new Map(ledger.accounts.map((a) => [a.number, a.name]));
  const centreNames = new Map(
    ledger.objects.filter((o) => o.dimension === COST_CENTRE_DIMENSION).map((o) => [o.code, o.name]),
  );

  // Sorted so a sync is stable: the same year exported twice produces the same pages
  // in the same order, which is what lets a consumer diff two runs and lets a test
  // assert on a page without sorting it first.
  const balances = [...sums.values()]
    .sort(
      (a, b) =>
        a.account.localeCompare(b.account) ||
        (a.costCentre ?? '').localeCompare(b.costCentre ?? '') ||
        a.month.localeCompare(b.month),
    )
    .map((s) => ({
      account: s.account,
      costCentre: s.costCentre,
      month: s.month,
      amount: moneyOf(s.amount, ledger.currency),
    }));

  return {
    currency: ledger.currency,
    balances,
    accounts: [...seenAccounts]
      .sort()
      .map((number) => ({ number, name: accountNames.get(number) ?? '' })),
    costCentres: [...seenCentres].sort().map((code) => ({ code, name: centreNames.get(code) ?? '' })),
    outOfRange,
  };
}
