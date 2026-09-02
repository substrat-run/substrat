/**
 * A small but deliberately awkward SIE4 file.
 *
 * Every oddity here is one a real Fortnox export carries, and each is the reason for a
 * specific assertion:
 *
 * - **Swedish characters** in company, account and object names — the latin1 canary.
 * - A **quoted text containing a quote** (`"Hyra \"juni\""`) — the escape path.
 * - A voucher whose `#TRANS` rows carry **their own date** in a different month from
 *   the `#VER` — so month bucketing must read the row, not the voucher.
 * - **Both signs**: a cost (debit-positive) and a revenue (credit, negative).
 * - Rows **with and without** a cost centre, so the `null` bucket is exercised.
 * - `#IB`/`#UB`/`#RES` balance posts, which must be **ignored** — including them
 *   double-counts every figure in the file.
 * - A `#DIM 6` object list alongside dimension 1, so cost-centre extraction must select
 *   dimension 1 rather than "the first object".
 * - A `#RAR -1` line for the previous year, which must NOT become the file's range.
 */
export const SIE_FIXTURE = [
  '#FLAGGA 0',
  '#PROGRAM "Fortnox" "3.0"',
  '#FORMAT PC8',
  '#SIETYP 4',
  '#FNAMN "Fastighets AB Älvsjö"',
  '#ORGNR 556677-8899',
  '#VALUTA SEK',
  '#RAR 0 20260101 20261231',
  '#RAR -1 20250101 20251231',
  '#KONTO 3010 "Hyresintäkter bostäder"',
  '#KONTO 4160 "Reparationer och underhåll"',
  '#KONTO 1510 "Kundfordringar"',
  '#KONTO 6570 "Bankkostnader"',
  '#DIM 1 "Kostnadsställe"',
  '#DIM 6 "Projekt"',
  '#OBJEKT 1 "2001" "Kvarteret Björken"',
  '#OBJEKT 1 "2002" "Kvarteret Önskan"',
  '#OBJEKT 6 "P1" "Stambyte"',
  // Balance posts — present in every real file, and every one of them must be skipped.
  '#IB 0 3010 -1200000.00',
  '#UB 0 3010 -2400000.00',
  '#RES 0 4160 350000.00',
  // A revenue voucher: credit, so debit-positive means NEGATIVE.
  '#VER A 12 20260615 "Hyra \\"juni\\""',
  '{',
  '#TRANS 3010 {"1" "2001"} -50000.00',
  '#TRANS 1510 {} 50000.00',
  '}',
  // A cost voucher whose rows carry their own dates, landing in TWO different months
  // from the voucher's own — the month-bucketing case.
  '#VER B 3 20260630 "Reparationer"',
  '{',
  '#TRANS 4160 {"1" "2001"} 12500.50 20260610 "Byte av lås"',
  '#TRANS 4160 {"1" "2002" "6" "P1"} 7499.50 20260705 "Stambyte etapp 1"',
  '#TRANS 1510 {} -20000.00 20260630',
  '}',
  // A second voucher on the same account/centre/month as the first cost row — so the
  // summariser has something to actually add.
  '#VER B 4 20260620 "Mer reparationer"',
  '{',
  '#TRANS 4160 {"1" "2001"} 500.25 20260620',
  '#TRANS 1510 {} -500.25 20260620',
  '}',
  // A row with no cost centre at all — the `null` bucket.
  '#VER C 1 20260731 "Bankavgift"',
  '{',
  '#TRANS 6570 {} 95.00',
  '#TRANS 1510 {} -95.00',
  '}',
  '',
].join('\r\n');
