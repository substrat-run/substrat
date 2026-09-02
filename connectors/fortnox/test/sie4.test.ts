import { describe, expect, it } from 'vitest';
import { parseSie4, sieAmount, sieDate, splitSieLine } from '../src/sie4.js';
import { financialYearFor, summarizeLedger } from '../src/aggregate.js';
import { SIE_FIXTURE } from './fixture.js';

describe('splitSieLine', () => {
  it('keeps a quoted field with spaces whole', () => {
    expect(splitSieLine('#KONTO 3010 "Hyresintäkter bostäder"')).toEqual([
      '#KONTO',
      '3010',
      'Hyresintäkter bostäder',
    ]);
  });

  it('honours backslash escapes inside a quoted field', () => {
    // Without this the field ends at the inner quote and the voucher text is truncated
    // to `Hyra ` — which looks like data, not a parse bug.
    expect(splitSieLine('#VER A 12 20260615 "Hyra \\"juni\\""')).toEqual([
      '#VER',
      'A',
      '12',
      '20260615',
      'Hyra "juni"',
    ]);
  });

  it('keeps a brace object list as one field, quotes and all', () => {
    expect(splitSieLine('#TRANS 4160 {"1" "2002" "6" "P1"} 7499.50')).toEqual([
      '#TRANS',
      '4160',
      '{"1" "2002" "6" "P1"}',
      '7499.50',
    ]);
  });

  it('keeps an empty object list as a field rather than dropping it', () => {
    // Dropping `{}` would shift every later field left by one, so the AMOUNT would be
    // read from the date column — a silent, total corruption.
    expect(splitSieLine('#TRANS 1510 {} 50000.00')).toEqual(['#TRANS', '1510', '{}', '50000.00']);
  });
});

describe('sieAmount', () => {
  it('normalizes to a plain signed decimal string, never a float', () => {
    expect(sieAmount('-50000.00')).toBe('-50000.00');
    expect(sieAmount('+120')).toBe('120');
    expect(sieAmount('1 234.50')).toBe('1234.50');
    expect(sieAmount('12,50')).toBe('12.50');
  });

  it('answers 0 for junk rather than NaN', () => {
    expect(sieAmount('abc')).toBe('0');
    expect(sieAmount('-')).toBe('0');
    expect(sieAmount(undefined)).toBe('0');
  });
});

describe('sieDate', () => {
  it('normalizes YYYYMMDD and passes anything else through', () => {
    expect(sieDate('20260615')).toBe('2026-06-15');
    expect(sieDate('2026-06-15')).toBe('2026-06-15');
  });
});

describe('parseSie4', () => {
  const ledger = parseSie4(SIE_FIXTURE);

  it('reads the header, including Swedish characters', () => {
    expect(ledger.company).toBe('Fastighets AB Älvsjö');
    expect(ledger.organizationNumber).toBe('556677-8899');
    expect(ledger.currency).toBe('SEK');
  });

  it('takes the range from #RAR 0 and ignores the comparison year', () => {
    expect(ledger.range).toEqual({ from: '2026-01-01', to: '2026-12-31' });
  });

  it('reads accounts and dimension-1 objects with their names', () => {
    expect(ledger.accounts).toContainEqual({ number: '4160', name: 'Reparationer och underhåll' });
    expect(ledger.objects).toContainEqual({
      dimension: '1',
      code: '2002',
      name: 'Kvarteret Önskan',
    });
    expect(ledger.objects).toContainEqual({ dimension: '6', code: 'P1', name: 'Stambyte' });
  });

  it('attaches transactions to their voucher and unpacks the object list', () => {
    const b3 = ledger.vouchers.find((v) => v.series === 'B' && v.number === '3')!;
    expect(b3.transactions).toHaveLength(3);
    expect(b3.transactions[1]!.objects).toEqual({ '1': '2002', '6': 'P1' });
    expect(b3.transactions[2]!.objects).toEqual({});
  });

  it('lets a #TRANS date override its voucher date', () => {
    const b3 = ledger.vouchers.find((v) => v.series === 'B' && v.number === '3')!;
    expect(b3.date).toBe('2026-06-30');
    expect(b3.transactions[0]!.date).toBe('2026-06-10');
    expect(b3.transactions[1]!.date).toBe('2026-07-05');
  });

  it('keeps SIE debit-positive signs rather than normalizing them', () => {
    const a12 = ledger.vouchers.find((v) => v.series === 'A')!;
    // A revenue account is a credit, so it is negative. Normalizing here would put
    // business meaning in a format reader.
    expect(a12.transactions[0]!.amount).toBe('-50000.00');
    expect(a12.transactions[1]!.amount).toBe('50000.00');
  });

  it('ignores #IB / #UB / #RES — including them double-counts every figure', () => {
    // The fixture carries an #IB and #UB on 3010 and a #RES on 4160. If any leaked in
    // as a transaction, these totals would be wrong.
    const all = ledger.vouchers.flatMap((v) => v.transactions);
    expect(all).toHaveLength(9);
    expect(all.filter((t) => t.account === '3010')).toHaveLength(1);
  });
});

describe('summarizeLedger', () => {
  const ledger = parseSie4(SIE_FIXTURE);

  it('sums per account, cost centre and month with exact decimals', () => {
    const summary = summarizeLedger(ledger);
    const cell = summary.balances.find(
      (b) => b.account === '4160' && b.costCentre === '2001' && b.month === '2026-06',
    );
    // 12500.50 + 500.25 — added over micro-units, so no float drift.
    expect(cell?.amount).toEqual({ amount: '13000.75', currency: 'SEK' });
  });

  it('buckets by the transaction date, not the voucher date', () => {
    const summary = summarizeLedger(ledger);
    // Voucher B/3 is dated 30 June, but this row carries 5 July.
    const july = summary.balances.find(
      (b) => b.account === '4160' && b.costCentre === '2002' && b.month === '2026-07',
    );
    expect(july?.amount.amount).toBe('7499.50');
  });

  it('keeps rows with no cost centre in their own bucket', () => {
    const summary = summarizeLedger(ledger);
    const bank = summary.balances.find((b) => b.account === '6570');
    expect(bank?.costCentre).toBeNull();
    expect(bank?.amount.amount).toBe('95.00');
  });

  it('selects dimension 1 as the cost centre, not whichever object came first', () => {
    const summary = summarizeLedger(ledger);
    // The 2002 row also carries a dimension-6 object; the cost centre must still be 2002.
    expect(summary.costCentres.map((c) => c.code)).toEqual(['2001', '2002']);
    expect(summary.costCentres).toContainEqual({ code: '2002', name: 'Kvarteret Önskan' });
  });

  it('filters to the window and counts what it dropped', () => {
    const summary = summarizeLedger(ledger, { from: '2026-06-01', to: '2026-06-30' });
    expect(summary.balances.every((b) => b.month === '2026-06')).toBe(true);
    // The July repair and the July bank fee fall outside.
    expect(summary.outOfRange).toBe(3);
  });

  it('is stable — the same ledger summarizes to the same order twice', () => {
    expect(summarizeLedger(ledger)).toEqual(summarizeLedger(ledger));
  });
});

describe('financialYearFor', () => {
  const years = [
    { Id: 1, FromDate: '2025-04-24', ToDate: '2025-12-31' },
    { Id: 2, FromDate: '2026-01-01', ToDate: '2026-12-31' },
  ];

  it('finds a year that only OVERLAPS the period', () => {
    // The PDF's trap: a first financial year starting 24 April. A search for the year
    // *containing* 1 January finds nothing and the sync silently reports empty books.
    expect(financialYearFor(years, { from: '2025-01-01', to: '2025-12-31' })?.Id).toBe(1);
  });

  it('prefers the later year when a period spans a boundary', () => {
    expect(financialYearFor(years, { from: '2025-12-01', to: '2026-01-31' })?.Id).toBe(2);
  });

  it('answers null when nothing overlaps', () => {
    expect(financialYearFor(years, { from: '2020-01-01', to: '2020-12-31' })).toBeNull();
  });
});
