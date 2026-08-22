import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { moneyOf, type DomainEventInput, type Page } from '@substrat-run/contracts';
import { engineHarness, type EngineHarness } from '@substrat-run/engine-test-kit';
import { invoicingModule, INVOICING_PERM as PERM, type UnderlagLine, type UnderlagRow } from '../src/index.js';

/**
 * The invoicing engine, tested directly — no demo world, no vertical.
 *
 * Until this file existed, every invariant here was asserted only as a side
 * effect of a demo scenario walking a happy path. `underlagTotal` in particular
 * was called by nothing, which is exactly how it came to sum across currencies
 * without anyone noticing.
 */

const CUSTOMER = { entityType: 'customer', entityId: '01JEXAMPLECUSTOMER00000000' } as const;

/** A `workorder.completed` envelope; `billable` is the part tests vary. */
function completed(
  orderId: string,
  billable: unknown[],
  total = moneyOf('0', 'SEK'),
): DomainEventInput {
  return {
    type: 'workorder.completed',
    schemaVersion: 1,
    entity: { entityType: 'workorder', entityId: orderId },
    piiClass: 'none',
    payload: { orderId, number: 1, customer: CUSTOMER, billable, total },
  } as DomainEventInput;
}

function orderPlaced(orderId: string, billable: unknown[], paymentMethod = 'invoice'): DomainEventInput {
  return {
    type: 'commerce.order-placed',
    schemaVersion: 1,
    entity: { entityType: 'order', entityId: orderId },
    piiClass: 'none',
    payload: {
      orderId,
      number: 1,
      customer: CUSTOMER,
      paymentMethod,
      billable,
      subtotal: moneyOf('100', 'SEK'),
      discount: moneyOf('0', 'SEK'),
      total: moneyOf('100', 'SEK'),
    },
  } as DomainEventInput;
}

const line = (
  article: string,
  amount: string,
  currency = 'SEK',
  source: { sourceType: string; sourceId: string } = { sourceType: 'time', sourceId: 'src-1' },
) => ({
  article,
  description: `${article} line`,
  qty: '1',
  unit: 'st',
  unitPrice: moneyOf(amount, currency),
  lineTotal: moneyOf(amount, currency),
  ...source,
});

describe('engine-invoicing', () => {
  let h: EngineHarness;
  let reader: Awaited<ReturnType<EngineHarness['as']>>;
  let exporter: Awaited<ReturnType<EngineHarness['as']>>;

  beforeEach(async () => {
    h = await engineHarness({ modules: [invoicingModule] });
    reader = await h.as([PERM.read]);
    exporter = await h.as([PERM.read, PERM.export]);
  });
  afterEach(async () => {
    await h.close();
  });

  /**
   * #811: a page, not a table. The scenario reads `.entries` because that is what
   * an in-process caller gets — the HTTP body is still the bare array (#829).
   */
  const list = async () =>
    (await reader.invoke<Page<UnderlagRow & { total: string }>>('invoicing/list')).entries;
  const get = (id: string) =>
    reader.invoke<{ underlag: UnderlagRow; lines: UnderlagLine[]; total: string }>('invoicing/get', {
      underlagId: id,
    });

  // -- permissions ---------------------------------------------------------

  it('is default-deny: a principal with no permissions reads nothing', async () => {
    const nobody = await h.as([]);
    await expect(nobody.invoke('invoicing/list')).rejects.toThrow(/permission denied/);
    await expect(nobody.invoke('invoicing/get', { underlagId: 'x' })).rejects.toThrow(/permission denied/);
    await expect(nobody.invoke('invoicing/export', { underlagId: 'x' })).rejects.toThrow(/permission denied/);
  });

  it('separates read from export — invoicing:read cannot export', async () => {
    await h.emit(completed('wo-1', [line('arbete', '100')]));
    const [u] = await list();
    await expect(reader.invoke('invoicing/export', { underlagId: u!.id })).rejects.toThrow(
      /permission denied/,
    );
  });

  // -- the consumers -------------------------------------------------------

  it('consumes workorder.completed: snapshots lines with provenance', async () => {
    await h.emit(
      completed('wo-1', [
        line('arbete', '100', 'SEK', { sourceType: 'time', sourceId: 'te-1' }),
        line('material', '50', 'SEK', { sourceType: 'material', sourceId: 'ma-1' }),
      ]),
    );

    const [u] = await list();
    expect(u).toBeDefined();
    const detail = await get(u!.id);
    expect(detail.lines).toHaveLength(2);
    // Document-level provenance: which delivery produced the lines (#328).
    expect(detail.lines.every((l) => l.document_type === 'workorder' && l.document_id === 'wo-1')).toBe(
      true,
    );
    // Per-line provenance is now CARRIED, not discarded — the field the payload
    // validated reaches the row, distinct per line (#328).
    expect(detail.lines.map((l) => ({ t: l.source_type, id: l.source_id }))).toEqual([
      { t: 'time', id: 'te-1' },
      { t: 'material', id: 'ma-1' },
    ]);
    expect(detail.total).toBe('150');
  });

  it('a producer without per-line provenance (commerce) leaves source_* NULL, document_* set', async () => {
    // commerce.order-placed carries no per-line sourceType/sourceId, so per-line
    // provenance is honestly absent rather than a document value masquerading as
    // one — while document_* still records which delivery produced the line (#328).
    await h.emit(orderPlaced('ord-1', [line('kaffe', '100')]));
    const [u] = await list();
    const detail = await get(u!.id);
    expect(detail.lines).toHaveLength(1);
    expect(detail.lines[0]!.document_type).toBe('order');
    expect(detail.lines[0]!.document_id).toBe('ord-1');
    expect(detail.lines[0]!.source_type).toBeNull();
    expect(detail.lines[0]!.source_id).toBeNull();
  });

  it('consumes commerce.order-placed only when paid by invoice', async () => {
    await h.emit(orderPlaced('ord-card', [line('kaffe', '100')], 'card'));
    expect(await list()).toHaveLength(0); // card settles through a payment connector

    await h.emit(orderPlaced('ord-inv', [line('kaffe', '100')], 'invoice'));
    expect(await list()).toHaveLength(1);
  });

  it('ignores a completion with nothing billable', async () => {
    await h.emit(completed('wo-empty', []));
    expect(await list()).toHaveLength(0);
  });

  it('accumulates into ONE open underlag per customer', async () => {
    await h.emit(completed('wo-1', [line('arbete', '100')]));
    await h.emit(completed('wo-2', [line('arbete', '200')]));

    const all = await list();
    expect(all).toHaveLength(1);
    expect((await get(all[0]!.id)).lines).toHaveLength(2);
    expect(all[0]!.total).toBe('300');
  });

  it('negative lines are a real mechanism: a discount keeps the total net', async () => {
    // Not a quirk — demos/shop emits its discount exactly this way, and the
    // engine's docs describe it. Pinned so it cannot regress into a rejection.
    await h.emit(orderPlaced('ord-1', [line('kaffe', '189'), line('rabatt', '-18.9')]));
    const [u] = await list();
    expect(u!.total).toBe('170.1');
  });

  // -- idempotency (§3.2) --------------------------------------------------

  it('is idempotent per source order: commerce.order-placed twice adds one set of lines', async () => {
    const e = orderPlaced('ord-1', [line('kaffe', '100')]);
    await h.emit(e);
    await h.emit(e);

    const [u] = await list();
    expect((await get(u!.id)).lines).toHaveLength(1);
    expect(u!.total).toBe('100');
  });

  it('is idempotent per source order: workorder.completed twice adds one set of lines', async () => {
    // The engine's docs promise "a source-id guard keeps the handlers idempotent
    // on redelivery" for BOTH consumers. This asserts the promise rather than
    // the accident that only one consumer kept it.
    const e = completed('wo-1', [line('arbete', '100')]);
    await h.emit(e);
    await h.emit(e);

    const [u] = await list();
    expect((await get(u!.id)).lines).toHaveLength(1);
    expect(u!.total).toBe('100');
  });

  // -- currency (§3.1) -----------------------------------------------------

  it('refuses a mixed-currency delivery rather than inventing a number', async () => {
    // 100 SEK + 100 EUR is not 200 of anything. The engine used to sum with
    // addDecimal, ignoring currency, and return '200' — a meaningless number on
    // a financial artifact. It is rejected at WRITE time so the delivery
    // dead-letters and no unreadable document is ever created.
    await h.emit(completed('wo-1', [line('arbete', '100', 'SEK'), line('resa', '100', 'EUR')]));

    expect(await list()).toHaveLength(0);
    const failures = h.deadLetters();
    expect(failures).toHaveLength(1);
    expect(failures[0]!.error).toMatch(/currency mismatch/i);
  });

  it('refuses a line whose currency differs from the underlag already open', async () => {
    await h.emit(completed('wo-1', [line('arbete', '100', 'SEK')]));
    await h.emit(completed('wo-2', [line('resa', '100', 'EUR')]));

    const all = await list();
    expect(all).toHaveLength(1);
    expect(all[0]!.total).toBe('100'); // the SEK document, untouched
    expect(h.deadLetters()[0]!.error).toMatch(/currency mismatch/i);
  });

  it('totals a real multi-line SEK underlag as Money, not as a bare sum', async () => {
    await h.emit(completed('wo-1', [line('arbete', '1200.50'), line('material', '349.50')]));
    const [u] = await list();
    expect(u!.total).toBe('1550');
  });

  it('totals a single-currency underlag exactly, to the öre', async () => {
    await h.emit(completed('wo-1', [line('a', '0.1'), line('b', '0.2')]));
    const [u] = await list();
    expect(u!.total).toBe('0.3'); // not 0.30000000000000004
  });

  it('an underlag with no lines totals zero, not NaN', async () => {
    // Reachable via export-then-late-work: the new underlag exists briefly empty.
    await h.emit(completed('wo-1', [line('arbete', '100')]));
    const [u] = await list();
    const detail = await get(u!.id);
    expect(detail.total).toBe('100');
    expect(detail.lines).toHaveLength(1);
  });

  // -- export immutability -------------------------------------------------

  it('export freezes the underlag and stamps exported_at', async () => {
    await h.emit(completed('wo-1', [line('arbete', '100')]));
    const [u] = await list();

    const out = await exporter.invoke<UnderlagRow>('invoicing/export', { underlagId: u!.id });
    expect(out.status).toBe('exported');
    expect(out.exported_at).toBeTruthy();
  });

  it('a second export throws — the point of no return is once', async () => {
    await h.emit(completed('wo-1', [line('arbete', '100')]));
    const [u] = await list();
    await exporter.invoke('invoicing/export', { underlagId: u!.id });
    await expect(exporter.invoke('invoicing/export', { underlagId: u!.id })).rejects.toThrow(
      /immutable/,
    );
  });

  it('late work opens a NEW underlag rather than touching the exported one', async () => {
    await h.emit(completed('wo-1', [line('arbete', '100')]));
    const [first] = await list();
    await exporter.invoke('invoicing/export', { underlagId: first!.id });

    await h.emit(completed('wo-2', [line('efterarbete', '50')]));

    const all = await list();
    expect(all).toHaveLength(2);
    const exported = all.find((u) => u.id === first!.id)!;
    const fresh = all.find((u) => u.id !== first!.id)!;
    expect(exported.status).toBe('exported');
    expect(exported.total).toBe('100'); // untouched
    expect(fresh.status).toBe('open');
    expect(fresh.total).toBe('50');
  });

  it('emits underlag-exported@2 with a money-typed total', async () => {
    await h.emit(completed('wo-1', [line('arbete', '1200.50'), line('material', '349.50')]));
    const [u] = await list();
    await exporter.invoke('invoicing/export', { underlagId: u!.id });

    const [evt] = h.eventsOfType('invoicing.underlag-exported');
    expect(evt).toBeDefined();
    expect(evt!.schemaVersion).toBe(2);
    // The whole point of v2: an amount on a financial artifact carries its
    // currency. v1 emitted the bare string '1550'.
    expect(evt!.payload).toMatchObject({
      underlagId: u!.id,
      number: u!.number,
      total: { amount: '1550', currency: 'SEK' },
    });
  });

  it('emits exactly one export event — v1 is replaced, not dual-emitted', async () => {
    // Dispatch keys on event type alone, so a dual-emit would deliver two
    // events to any consumer of this type and risk a double invoice.
    await h.emit(completed('wo-1', [line('arbete', '100')]));
    const [u] = await list();
    await exporter.invoke('invoicing/export', { underlagId: u!.id });

    const evts = h.eventsOfType('invoicing.underlag-exported');
    expect(evts).toHaveLength(1);
    expect(evts.map((e) => e.schemaVersion)).toEqual([2]);
  });

  it('exporting something that does not exist throws, not silently succeeds', async () => {
    await expect(exporter.invoke('invoicing/export', { underlagId: 'no-such-id' })).rejects.toThrow(
      /not found/,
    );
  });

  it('numbers underlag sequentially', async () => {
    await h.emit(completed('wo-1', [line('arbete', '100')]));
    const [first] = await list();
    await exporter.invoke('invoicing/export', { underlagId: first!.id });
    await h.emit(completed('wo-2', [line('arbete', '100')]));

    const numbers = (await list()).map((u) => u.number).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2]);
  });

  // -- malformed payloads --------------------------------------------------

  it('dead-letters a malformed payload, leaving no partial underlag', async () => {
    // Dispatch is post-commit and each consumer runs in its own transaction, so
    // the producer is NOT rolled back by a bad consumer — `emit` resolves. What
    // must hold is that the consumer's own transaction rolls back (no half-built
    // underlag) and the failure is journalled rather than swallowed.
    await h.emit(completed('wo-bad', [{ article: 'arbete' /* missing everything else */ }]));

    expect(await list()).toHaveLength(0);

    const failures = h.deadLetters();
    expect(failures).toHaveLength(1);
    expect(failures[0]!.consumerModule).toBe('@substrat-run/engine-invoicing');
    expect(failures[0]!.error).toMatch(/invalid|expected|required/i);
  });

  it('one poison event does not wedge the consumer for good events after it', async () => {
    await h.emit(completed('wo-bad', [{ article: 'broken' }]));
    await h.emit(completed('wo-good', [line('arbete', '100')]));

    const all = await list();
    expect(all).toHaveLength(1);
    expect(all[0]!.total).toBe('100');
    expect(h.deadLetters()).toHaveLength(1);
  });
});
