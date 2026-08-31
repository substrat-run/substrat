import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  errorCodeOf,
  moneyOf,
  type DomainEventInput,
  type Page,
} from '@substrat-run/contracts';
import { engineHarness, type EngineHarness } from '@substrat-run/engine-test-kit';
import {
  invoicingModule,
  INVOICING_PERM as PERM,
  type UnderlagLine,
  type UnderlagRow,
} from '../src/index.js';
import { columnsOf } from '../src/seam.js';
import { underlagLine, underlagRow } from '../src/entities.js';

/**
 * The seam, under drift (#771/#970) — engine-invoicing' copy of workorder's suite.
 *
 * Every test here answers one question: when the stored row stops matching the
 * shape this engine PUBLISHES, does the caller get a throw or wrong data? Before
 * this, the answer was wrong data — the return values crossed the seam typed by a
 * TypeScript assertion that is not there at runtime, and `SELECT *` pinned the
 * published shape to whatever the physical table happened to hold.
 *
 * The reach of "parse always" here is the money. `line_total_amount` and
 * `currency` are folded into the total that goes out on
 * `invoicing.underlag-exported`, which an accounting connector invoices — so a
 * drifted summand is not a rendering bug, it is a wrong number on a real
 * document, arriving with no error anywhere.
 *
 * The drift is simulated the only honest way available: by moving the table under
 * a running engine, which is what a vertical compiled against 0.3 and running
 * against 0.4 is actually looking at.
 */

const CUSTOMER = { entityType: 'customer', entityId: '01JEXAMPLECUSTOMER00000000' } as const;

const completed = (orderId: string, amount = '100'): DomainEventInput =>
  ({
    type: 'workorder.completed',
    schemaVersion: 1,
    entity: { entityType: 'workorder', entityId: orderId },
    piiClass: 'none',
    payload: {
      orderId,
      number: 1,
      customer: CUSTOMER,
      billable: [
        {
          article: 'arbete',
          description: 'arbete line',
          qty: '1',
          unit: 'st',
          unitPrice: moneyOf(amount, 'SEK'),
          lineTotal: moneyOf(amount, 'SEK'),
          sourceType: 'time',
          sourceId: 'te-1',
        },
      ],
      total: moneyOf(amount, 'SEK'),
    },
  }) as DomainEventInput;

describe('engine-invoicing — the seam is parsed, not asserted', () => {
  let h: EngineHarness;
  let exporter: Awaited<ReturnType<EngineHarness['as']>>;

  beforeEach(async () => {
    h = await engineHarness({ modules: [invoicingModule] });
    exporter = await h.as([PERM.read, PERM.export]);
    await h.emit(completed('wo-1'));
  });
  afterEach(async () => {
    await h.close();
  });

  const list = () =>
    exporter.invoke<Page<UnderlagRow & { total: string }>>('invoicing/list');
  const firstId = async () => (await list()).entries[0]!.id;

  /** Move the table under the engine, the way a version bump would. */
  const drift = (sql: string) => h.run((ctx) => void ctx.sql.exec(sql), [PERM.read]);

  // -- the SELECT list is derived from the row schema ---------------------------

  it('names the columns a row schema describes, in its order', () => {
    expect(columnsOf(underlagRow)).toBe(
      'id, number, customer_type, customer_id, status, created_at, exported_at',
    );
    expect(columnsOf(underlagLine)).toBe(
      'id, underlag_id, document_type, document_id, source_type, source_id, article, ' +
        'description, qty, unit, unit_price_amount, currency, line_total_amount, created_at',
    );
  });

  it('a column that vanished fails AT THE READ, naming itself', async () => {
    const id = await firstId();
    // The published shape still says `exported_at`; the table no longer does.
    await drift('ALTER TABLE invoicing_underlag DROP COLUMN exported_at');

    // `SELECT *` would have returned a row quietly missing the field. Naming the
    // columns makes the read itself refuse, and say which column it wanted.
    await expect(exporter.invoke('invoicing/get', { underlagId: id })).rejects.toThrow(
      /no such column: exported_at/,
    );
  });

  it('a column added upstream never crosses the seam', async () => {
    await drift('ALTER TABLE invoicing_underlag ADD COLUMN internal_margin TEXT');
    await drift(`UPDATE invoicing_underlag SET internal_margin = '0.4'`);

    const page = await list();
    for (const row of page.entries) {
      expect(Object.keys(row).sort()).toEqual(
        [
          'id',
          'number',
          'customer_type',
          'customer_id',
          'status',
          'created_at',
          'exported_at',
          'total',
        ].sort(),
      );
      expect(row).not.toHaveProperty('internal_margin');
    }
  });

  // -- a drifted row throws instead of surfacing as wrong data ------------------

  it('a retyped column throws BEFORE the export transition is judged', async () => {
    const id = await firstId();
    // `number` is the invoice-basis number a document is identified by, and it
    // is a NUMBER in the published shape. `status` would be the sharper drift,
    // but migration 0001 puts a CHECK on it — so within one schema version the
    // table itself holds that one, and the seam is what holds it across a
    // version bump. `number`'s column has INTEGER affinity, so a non-numeric
    // value stays text and the drift is real.
    await drift(`UPDATE invoicing_underlag SET number = 'ett'`);

    await expect(exporter.invoke('invoicing/get', { underlagId: id })).rejects.toThrow(
      /does not match the shape this engine publishes.*number/s,
    );
    await expect(exporter.invoke('invoicing/list')).rejects.toThrow(
      /does not match the shape this engine publishes/,
    );
    await expect(exporter.invoke('invoicing/export', { underlagId: id })).rejects.toThrow(
      /does not match the shape this engine publishes/,
    );

    // And the export did NOT happen: the refusal is before the state change, so
    // a drifted basis is not left `exported` — which is terminal and immutable.
    await drift(`UPDATE invoicing_underlag SET number = 1`);
    const detail = await exporter.invoke<{ underlag: UnderlagRow }>('invoicing/get', {
      underlagId: id,
    });
    expect(detail.underlag.status).toBe('open');
  });

  it('a drifted line amount refuses the fold rather than invoicing a plausible total', async () => {
    const id = await firstId();
    // The total is a sum, so a drifted summand crosses as a NUMBER nobody
    // questions — and this one leaves on the export event.
    await drift(`UPDATE invoicing_lines SET line_total_amount = 'hundra kronor'`);

    await expect(exporter.invoke('invoicing/get', { underlagId: id })).rejects.toThrow(
      /does not match the shape this engine publishes/,
    );
    await expect(exporter.invoke('invoicing/export', { underlagId: id })).rejects.toThrow(
      /does not match the shape this engine publishes/,
    );
    // Named, so the message says which value refused rather than reporting an
    // `amount` that appears in no column of this engine.
    await expect(exporter.invoke('invoicing/get', { underlagId: id })).rejects.toThrow(
      /line_total_amount/,
    );
    // And the export did NOT happen: the refusal is before the state change.
    await drift(`UPDATE invoicing_lines SET line_total_amount = '100'`);
    const detail = await exporter.invoke<{ underlag: UnderlagRow }>('invoicing/get', {
      underlagId: id,
    });
    expect(detail.underlag.status).toBe('open');
  });

  it('a drifted qty refuses the detail read it would have rendered', async () => {
    const id = await firstId();
    // `qty` multiplies nothing here — the line total is snapshotted — so a
    // drifted one is the purest wrong-data case in this engine: it renders.
    await drift(`UPDATE invoicing_lines SET qty = 'två'`);

    const err = await exporter
      .invoke<{ lines: UnderlagLine[] }>('invoicing/get', { underlagId: id })
      .catch((e: unknown) => e);
    expect(String(err)).toMatch(/does not match the shape this engine publishes.*qty/s);
  });

  it('blames the engine, not the caller: a drifted row is `internal`', async () => {
    const id = await firstId();
    await drift(`UPDATE invoicing_underlag SET number = 'ett'`);

    // The caller's input was already parsed and is not what went wrong, so this
    // must not answer 400 `validation_failed` — that is a lie a client acts on.
    const err = await exporter
      .invoke('invoicing/get', { underlagId: id })
      .catch((e: unknown) => e);
    expect(errorCodeOf(err)).toBe('internal');
  });
});
