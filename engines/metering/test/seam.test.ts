import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { errorCodeOf, type Page } from '@substrat-run/contracts';
import { manualClock } from '@substrat-run/kernel';
import { engineHarness, type EngineHarness } from '@substrat-run/engine-test-kit';
import {
  PERM,
  meteringModule,
  closePeriod,
  configureMeter,
  listEntries,
  listMeters,
  listPeriods,
  periodLines,
  recordUsage,
  usageTotal,
  type Meter,
  type UsageEntry,
} from '../src/index.js';
import { columnsOf } from '../src/seam.js';
import { entryRow, meterRow, periodRow } from '../src/entities.js';

/**
 * The seam, under drift (#771/#970) — engine-metering's copy of workorder's suite.
 *
 * Every test here answers one question: when the stored row stops matching the
 * shape this engine PUBLISHES, does the caller get a throw or wrong data? Before
 * this, the answer was wrong data — the return values crossed the seam typed by a
 * TypeScript assertion that is not there at runtime, and `SELECT *` pinned the
 * published shape to whatever the physical table happened to hold.
 *
 * The reach of "parse always" here is the bill. `qty` is folded by
 * `aggregateMeter` into a period line, and a line is what a vertical prices and
 * hands to invoicing — so a drifted summand crosses as a NUMBER nobody questions,
 * and the close that freezes it is immutable afterwards. `occurred_at` is the
 * other one: every window is a string comparison over instants at one precision.
 *
 * The drift is simulated the only honest way available: by moving the table under
 * a running engine, which is what a vertical compiled against 0.3 and running
 * against 0.4 is actually looking at.
 */

const ALL = [PERM.read, PERM.record, PERM.configure, PERM.close];
const CLOCK_AT = '2030-02-01T00:00:00.000Z';
const t = (day: number) => `2030-01-${String(day).padStart(2, '0')}T00:00:00.000Z`;

describe('engine-metering — the seam is parsed, not asserted', () => {
  let h: EngineHarness;
  let staff: Awaited<ReturnType<EngineHarness['as']>>;

  beforeEach(async () => {
    h = await engineHarness({ modules: [meteringModule], clock: manualClock(CLOCK_AT).read });
    staff = await h.as(ALL);
    await h.run((ctx) => {
      configureMeter(ctx, { key: 'ai.tokens', kind: 'counter', unit: 'tokens' });
      recordUsage(ctx, { meter: 'ai.tokens', qty: '100', dedupeKey: 'k1', occurredAt: t(2) });
      recordUsage(ctx, { meter: 'ai.tokens', qty: '50', dedupeKey: 'k2', occurredAt: t(3) });
    }, ALL);
  });
  afterEach(async () => {
    await h.close();
  });

  /** Move the table under the engine, the way a version bump would. */
  const drift = (sql: string) => h.run((ctx) => void ctx.sql.exec(sql), ALL);

  const total = () =>
    h.run(
      (ctx) => usageTotal(ctx, { meter: 'ai.tokens', from: t(1), to: t(10) }),
      ALL,
    );

  // -- the SELECT list is derived from the row schema ---------------------------

  it('names the columns a row schema describes, in its order', () => {
    expect(columnsOf(meterRow)).toBe('key, kind, unit, description, active, created_at');
    expect(columnsOf(entryRow)).toBe(
      'id, meter_key, qty, subject_type, subject_id, occurred_at, dedupe_key, note, created_by, created_at',
    );
    expect(columnsOf(periodRow)).toBe('id, from_at, to_at, closed_by, closed_at');
  });

  it('a column that vanished fails AT THE READ, naming itself', async () => {
    // The published shape still says `note`; the table no longer does.
    await drift('ALTER TABLE metering_entries DROP COLUMN note');

    // `SELECT *` would have returned a row quietly missing the field. Naming the
    // columns makes the read itself refuse, and say which column it wanted.
    await expect(h.run((ctx) => listEntries(ctx), ALL)).rejects.toThrow(/no such column: note/);
    await expect(staff.invoke('metering/list-entries')).rejects.toThrow(/no such column: note/);
  });

  it('a column added upstream never crosses the seam', async () => {
    await drift('ALTER TABLE metering_meters ADD COLUMN internal_price TEXT');
    await drift(`UPDATE metering_meters SET internal_price = '0.002'`);

    const listed = await h.run((ctx) => listMeters(ctx), ALL);
    const paged = await staff.invoke<Page<Meter>>('metering/list-meters');
    for (const row of [...listed, ...paged.entries]) {
      expect(Object.keys(row)).toEqual([
        'key',
        'kind',
        'unit',
        'description',
        'active',
        'createdAt',
      ]);
      expect(row).not.toHaveProperty('internal_price');
    }
  });

  // -- a drifted row throws instead of surfacing as wrong data ------------------

  it('a drifted `qty` refuses the fold rather than answering a plausible total', async () => {
    // The total is a sum, so a drifted summand crosses as a NUMBER nobody
    // questions — and this one is frozen into a billed line.
    await drift(`UPDATE metering_entries SET qty = '100 tokens'`);

    await expect(total()).rejects.toThrow(
      /does not match the shape this engine publishes.*qty/s,
    );
    await expect(staff.invoke('metering/total', { meter: 'ai.tokens', from: t(1), to: t(10) }))
      .rejects.toThrow(/does not match the shape this engine publishes/);
    // The close folds through the SAME path, so it refuses too — which is what
    // matters: a period is immutable once written.
    await expect(h.run((ctx) => closePeriod(ctx, { from: t(1), to: t(10) }), ALL)).rejects.toThrow(
      /does not match the shape this engine publishes/,
    );
  });

  it('a drifted `occurred_at` is caught rather than sorted into the wrong window', async () => {
    // A legitimate ISO-8601 instant in a form this engine never promised: an
    // explicit offset instead of `Z`. It still sorts inside every window queried
    // here, so it reads and renders — and every comparison against a `…Z` value
    // is then decided by where `+` sorts against a digit, which is nobody's
    // intent. That is the whole reason `ISO_INSTANT` is one shape.
    await drift(
      `UPDATE metering_entries SET occurred_at = '2030-01-02T00:00:00.000+00:00' WHERE qty = '100'`,
    );

    await expect(h.run((ctx) => listEntries(ctx), ALL)).rejects.toThrow(
      /does not match the shape this engine publishes.*occurred_at/s,
    );
    await expect(staff.invoke<Page<UsageEntry>>('metering/list-entries')).rejects.toThrow(
      /does not match the shape this engine publishes/,
    );
    // The fold reads `occurred_at` too — it is what CHOSE these summands — so
    // refusing it only on the entry read would parse the number and trust the
    // thing that decided which numbers there were.
    await expect(total()).rejects.toThrow(
      /does not match the shape this engine publishes.*occurred_at/s,
    );
    // And the close, which freezes that choice into an immutable line.
    await expect(h.run((ctx) => closePeriod(ctx, { from: t(1), to: t(10) }), ALL)).rejects.toThrow(
      /does not match the shape this engine publishes.*occurred_at/s,
    );
    expect(await h.run((ctx) => listPeriods(ctx), ALL)).toEqual([]);
  });

  it('the gauge carry-forward is chosen by a parsed instant too', async () => {
    await h.run((ctx) => {
      configureMeter(ctx, { key: 'storage.bytes', kind: 'gauge', unit: 'bytes' });
      recordUsage(ctx, { meter: 'storage.bytes', qty: '10', dedupeKey: 'g1', occurredAt: t(2) });
    }, ALL);
    // No sample inside [t(5), t(10)), so the aggregate carries the LATEST
    // earlier one forward — a row picked by `occurred_at` and nothing else.
    await drift(
      `UPDATE metering_entries SET occurred_at = '2030-01-02T00:00:00.000+00:00' WHERE meter_key = 'storage.bytes'`,
    );

    await expect(
      h.run((ctx) => usageTotal(ctx, { meter: 'storage.bytes', from: t(5), to: t(10) }), ALL),
    ).rejects.toThrow(/does not match the shape this engine publishes.*occurred_at/s);
  });

  it('a retyped `active` is caught BEFORE it is normalised to a boolean', async () => {
    // `active` is 0/1 and `toMeter` reads it with `=== 1`. A text value would not
    // fail the published parse — it would quietly publish every meter as
    // inactive and refuse every `recordUsage` against it as `meter_inactive`.
    // (`'1'` would be coerced back by SQLite's column affinity, so the drift has
    // to be non-numeric.)
    await drift(`UPDATE metering_meters SET active = 'yes'`);

    await expect(h.run((ctx) => listMeters(ctx), ALL)).rejects.toThrow(
      /meter row .* does not match the shape this engine publishes.*active/s,
    );
    await expect(
      h.run(
        (ctx) => recordUsage(ctx, { meter: 'ai.tokens', qty: '1', dedupeKey: 'k3' }),
        ALL,
      ),
    ).rejects.toThrow(/does not match the shape this engine publishes.*active/s);
  });

  it('a drifted period and its lines are published through the same seam', async () => {
    await h.run((ctx) => void closePeriod(ctx, { from: t(1), to: t(10) }), ALL);
    const [period] = await h.run((ctx) => listPeriods(ctx), ALL);
    expect(period).toBeDefined();

    // A close is the immutable billing evidence, so its own row drifting is the
    // one that must never be answered with a plausible window.
    await drift(`UPDATE metering_periods SET from_at = '2030-01-1T00:00:00.000Z'`);
    await expect(h.run((ctx) => listPeriods(ctx), ALL)).rejects.toThrow(
      /does not match the shape this engine publishes.*from_at/s,
    );

    await drift(`UPDATE metering_periods SET from_at = '${t(1)}'`);
    await drift(`UPDATE metering_period_lines SET qty = '150 tokens'`);
    await expect(
      h.run((ctx) => periodLines(ctx, { periodId: period!.id }), ALL),
    ).rejects.toThrow(/does not match the shape this engine publishes.*qty/s);
  });

  it('blames the engine, not the caller: a drifted row is `internal`', async () => {
    await drift(`UPDATE metering_entries SET qty = '100 tokens'`);

    // The caller's input was already parsed and is not what went wrong, so this
    // must not answer 400 `validation_failed` — that is a lie a client acts on.
    const err = await h.run((ctx) => listEntries(ctx), ALL).catch((e: unknown) => e);
    expect(errorCodeOf(err)).toBe('internal');
  });
});
