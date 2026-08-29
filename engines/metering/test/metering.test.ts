import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { manualClock } from '@substrat-run/kernel';
import { engineHarness, type EngineHarness } from '@substrat-run/engine-test-kit';
import {
  PERM,
  meteringModule,
  configureMeter,
  listEntries,
  listMeters,
  listPeriods,
  periodLines,
  closePeriod,
  recordUsage,
  usageTotal,
} from '../src/index.js';

/**
 * The metering engine, tested directly: the idempotent ingest, the counter/
 * gauge aggregation split, and the close-horizon discipline that makes a
 * closed period's lines frozen billing evidence.
 */

const ALL = [PERM.read, PERM.record, PERM.configure, PERM.close];

/** UTC instant at millisecond precision (what the engine normalizes to). */
const t = (day: number, hour = 0) =>
  `2030-01-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`;

/**
 * The suite runs on a clock it owns, anchored past every `t(...)` fixture above.
 *
 * It used to run on the wall clock while recording usage in 2030 — every entry
 * post-dated by four years, which is precisely the state #1066 says must not be
 * reachable. Putting the harness clock where the fixtures already are makes the
 * suite say what it meant (usage recorded a little in the past, closed later)
 * and lets the forward bound be tested rather than tripped over.
 */
const CLOCK_AT = '2030-02-01T00:00:00.000Z';

describe('engine-metering', () => {
  let h: EngineHarness;
  let clock: ReturnType<typeof manualClock>;

  beforeEach(async () => {
    clock = manualClock(CLOCK_AT);
    h = await engineHarness({ modules: [meteringModule], clock: clock.read });
    await h.run((ctx) => {
      configureMeter(ctx, { key: 'ai.tokens.input', kind: 'counter', unit: 'tokens' });
      configureMeter(ctx, { key: 'storage.bytes', kind: 'gauge', unit: 'bytes' });
    }, ALL);
  });

  afterEach(async () => {
    await h.close();
  });

  // -------------------------------------------------------------------------
  // Meters: registry, frozen kind/unit
  // -------------------------------------------------------------------------

  it('registers meters; description and active update, kind and unit are frozen', async () => {
    await h.run((ctx) => {
      configureMeter(ctx, {
        key: 'ai.tokens.input',
        kind: 'counter',
        unit: 'tokens',
        description: 'prompt tokens',
        active: false,
      });
      const meter = listMeters(ctx).find((m) => m.key === 'ai.tokens.input')!;
      expect(meter.description).toBe('prompt tokens');
      expect(meter.active).toBe(false);

      expect(() =>
        configureMeter(ctx, { key: 'ai.tokens.input', kind: 'gauge', unit: 'tokens' }),
      ).toThrow(/frozen/);
      expect(() =>
        configureMeter(ctx, { key: 'ai.tokens.input', kind: 'counter', unit: 'megatokens' }),
      ).toThrow(/frozen/);
    }, ALL);
  });

  it('refuses to record against an unknown or inactive meter', async () => {
    await h.run((ctx) => {
      expect(() =>
        recordUsage(ctx, { meter: 'nope', qty: '1', dedupeKey: 'k1' }),
      ).toThrow(/meter not found/);
      configureMeter(ctx, { key: 'ai.tokens.input', kind: 'counter', unit: 'tokens', active: false });
      expect(() =>
        recordUsage(ctx, { meter: 'ai.tokens.input', qty: '1', dedupeKey: 'k1' }),
      ).toThrow(/inactive/);
    }, ALL);
  });

  // -------------------------------------------------------------------------
  // The ingest: idempotency (D-C)
  // -------------------------------------------------------------------------

  it('replaying a dedupe key with the same qty returns the existing entry — one row, one event', async () => {
    await h.run((ctx) => {
      const first = recordUsage(ctx, {
        meter: 'ai.tokens.input',
        qty: '1200',
        occurredAt: t(3),
        dedupeKey: 'turn-1',
      });
      expect(first.deduped).toBe(false);
      const replay = recordUsage(ctx, {
        meter: 'ai.tokens.input',
        qty: '1200',
        occurredAt: t(4), // even a different occurredAt: the key names ONE observation
        dedupeKey: 'turn-1',
      });
      expect(replay.deduped).toBe(true);
      expect(replay.entry.id).toBe(first.entry.id);
      expect(listEntries(ctx, { meter: 'ai.tokens.input' })).toHaveLength(1);
    }, ALL);
    expect(h.eventsOfType('metering.usage-recorded')).toHaveLength(1);
  });

  it('the same dedupe key with a DIFFERENT qty throws — an upstream bug, never swallowed', async () => {
    await h.run((ctx) => {
      recordUsage(ctx, { meter: 'ai.tokens.input', qty: '1200', occurredAt: t(3), dedupeKey: 'turn-1' });
      expect(() =>
        recordUsage(ctx, { meter: 'ai.tokens.input', qty: '9999', occurredAt: t(3), dedupeKey: 'turn-1' }),
      ).toThrow(/one observation/);
    }, ALL);
  });

  it('dedupe keys are per meter: one turn id records input AND output tokens', async () => {
    await h.run((ctx) => {
      configureMeter(ctx, { key: 'ai.tokens.output', kind: 'counter', unit: 'tokens' });
      recordUsage(ctx, { meter: 'ai.tokens.input', qty: '1200', occurredAt: t(3), dedupeKey: 'turn-1' });
      const out = recordUsage(ctx, { meter: 'ai.tokens.output', qty: '340', occurredAt: t(3), dedupeKey: 'turn-1' });
      expect(out.deduped).toBe(false);
    }, ALL);
  });

  // -------------------------------------------------------------------------
  // Aggregation: counters sum (signed), gauges sample and carry forward (D-B)
  // -------------------------------------------------------------------------

  it('a counter sums signed deltas over a half-open window', async () => {
    await h.run((ctx) => {
      recordUsage(ctx, { meter: 'ai.tokens.input', qty: '1000', occurredAt: t(2), dedupeKey: 'a' });
      recordUsage(ctx, { meter: 'ai.tokens.input', qty: '500', occurredAt: t(5), dedupeKey: 'b' });
      // a correction is a compensating entry, never an edit
      recordUsage(ctx, { meter: 'ai.tokens.input', qty: '-200', occurredAt: t(6), dedupeKey: 'c' });
      recordUsage(ctx, { meter: 'ai.tokens.input', qty: '9999', occurredAt: t(10), dedupeKey: 'd' });

      expect(usageTotal(ctx, { meter: 'ai.tokens.input', from: t(1), to: t(10) })).toEqual({
        qty: '1300',
        entryCount: 3, // t(10) excluded: half-open [from, to)
      });
      expect(usageTotal(ctx, { meter: 'ai.tokens.input', from: t(20), to: t(21) })).toBeNull();
    }, ALL);
  });

  it('a gauge aggregates as max-in-window and carries its level across silent windows', async () => {
    await h.run((ctx) => {
      recordUsage(ctx, { meter: 'storage.bytes', qty: '100', occurredAt: t(2), dedupeKey: 's1' });
      recordUsage(ctx, { meter: 'storage.bytes', qty: '900', occurredAt: t(3), dedupeKey: 's2' });
      recordUsage(ctx, { meter: 'storage.bytes', qty: '400', occurredAt: t(4), dedupeKey: 's3' });

      expect(usageTotal(ctx, { meter: 'storage.bytes', from: t(1), to: t(10) })).toEqual({
        qty: '900',
        entryCount: 3,
      });
      // no samples in [t10, t20) — the last level (400) persists, entryCount 0
      expect(usageTotal(ctx, { meter: 'storage.bytes', from: t(10), to: t(20) })).toEqual({
        qty: '400',
        entryCount: 0,
      });
      // a gauge never sampled has nothing to say
      configureMeter(ctx, { key: 'seats', kind: 'gauge', unit: 'seats' });
      expect(usageTotal(ctx, { meter: 'seats', from: t(1), to: t(10) })).toBeNull();
    }, ALL);
  });

  it('a gauge sample must be non-negative; counter deltas may be signed', async () => {
    await h.run((ctx) => {
      expect(() =>
        recordUsage(ctx, { meter: 'storage.bytes', qty: '-1', occurredAt: t(2), dedupeKey: 'g' }),
      ).toThrow(/non-negative/);
    }, ALL);
  });

  // -------------------------------------------------------------------------
  // Period close: frozen lines, fat event, the horizon (D-D)
  // -------------------------------------------------------------------------

  it('closePeriod freezes unpriced lines and emits one fat metering.period-closed event', async () => {
    await h.run((ctx) => {
      recordUsage(ctx, { meter: 'ai.tokens.input', qty: '1000', occurredAt: t(2), dedupeKey: 'a' });
      recordUsage(ctx, { meter: 'ai.tokens.input', qty: '500', occurredAt: t(5), dedupeKey: 'b' });
      recordUsage(ctx, { meter: 'storage.bytes', qty: '900', occurredAt: t(3), dedupeKey: 's1' });
      // a meter deactivated before close still bills what it recorded
      configureMeter(ctx, { key: 'ai.tokens.input', kind: 'counter', unit: 'tokens', active: false });
      // a counter with nothing in-window is omitted — a zero sum bills nothing
      configureMeter(ctx, { key: 'requests', kind: 'counter', unit: 'requests' });

      const { period, lines } = closePeriod(ctx, { from: t(1), to: t(10) });
      expect(lines).toEqual([
        { meterKey: 'ai.tokens.input', kind: 'counter', unit: 'tokens', qty: '1500', entryCount: 2 },
        { meterKey: 'storage.bytes', kind: 'gauge', unit: 'bytes', qty: '900', entryCount: 1 },
      ]);
      expect(periodLines(ctx, { periodId: period.id })).toEqual(lines);
      expect(listPeriods(ctx)).toHaveLength(1);
    }, ALL);

    const events = h.eventsOfType('metering.period-closed');
    expect(events).toHaveLength(1);
    const payload = events[0]!.payload as { from: string; to: string; lines: unknown[] };
    expect(payload.from).toBe(t(1));
    expect(payload.to).toBe(t(10));
    expect(payload.lines).toHaveLength(2);
    expect(events[0]!.piiClass).toBe('none');
  });

  it('closes are monotonic: an overlap with the horizon is refused, a gap is fine', async () => {
    await h.run((ctx) => {
      closePeriod(ctx, { from: t(1), to: t(10) });
      expect(() => closePeriod(ctx, { from: t(5), to: t(20) })).toThrow(/horizon/);
      expect(() => closePeriod(ctx, { from: t(12), to: t(12) })).toThrow(/after/);
      // a gap between closes is allowed; the next close starts at or after the horizon
      closePeriod(ctx, { from: t(15), to: t(20) });
      expect(listPeriods(ctx)).toHaveLength(2);
    }, ALL);
  });

  it('nothing lands behind the horizon: a closed period is reproducible forever', async () => {
    await h.run((ctx) => {
      recordUsage(ctx, { meter: 'ai.tokens.input', qty: '1000', occurredAt: t(2), dedupeKey: 'a' });
      closePeriod(ctx, { from: t(1), to: t(10) });
      expect(() =>
        recordUsage(ctx, { meter: 'ai.tokens.input', qty: '5', occurredAt: t(9), dedupeKey: 'late' }),
      ).toThrow(/close horizon/);
      // exactly AT the horizon is the next period's first instant — allowed
      const ok = recordUsage(ctx, { meter: 'ai.tokens.input', qty: '5', occurredAt: t(10), dedupeKey: 'next' });
      expect(ok.deduped).toBe(false);
    }, ALL);
  });

  it('nothing lands AHEAD of the clock either: a post-dated entry no close would reach is refused', async () => {
    await h.run((ctx) => {
      // The mirror of the horizon rule, and the one that used to be missing
      // (#1066). `closePeriod` only ever advances the horizon forward, so an
      // entry parked past every period anyone will close is aggregated by none
      // of them — billable usage leaving the stream with no error anywhere.
      expect(() =>
        recordUsage(ctx, {
          meter: 'ai.tokens.input',
          qty: '1000000',
          occurredAt: '2031-01-01T00:00:00.000Z',
          dedupeKey: 'far-future',
        }),
      ).toThrow(/ahead of/);
      // …and nothing was written on the way to refusing.
      expect(listEntries(ctx, { meter: 'ai.tokens.input' })).toHaveLength(0);

      // An hour ahead is still refused: the tolerance is for clock skew, not for
      // scheduling usage that has not happened.
      expect(() =>
        recordUsage(ctx, {
          meter: 'ai.tokens.input',
          qty: '1',
          occurredAt: '2030-02-01T01:00:00.000Z',
          dedupeKey: 'an-hour-out',
        }),
      ).toThrow(/ahead of/);
    }, ALL);
  });

  it('the instants that must keep working still do: now, inside the tolerance, and behind it', async () => {
    await h.run((ctx) => {
      // The default — no `occurredAt` at all.
      expect(recordUsage(ctx, { meter: 'ai.tokens.input', qty: '1', dedupeKey: 'd' }).deduped).toBe(
        false,
      );
      // Exactly the operation's own instant.
      expect(
        recordUsage(ctx, {
          meter: 'ai.tokens.input',
          qty: '2',
          occurredAt: CLOCK_AT,
          dedupeKey: 'exact',
        }).deduped,
      ).toBe(false);
      // A producer whose clock runs a minute fast — inside the skew tolerance.
      expect(
        recordUsage(ctx, {
          meter: 'ai.tokens.input',
          qty: '3',
          occurredAt: '2030-02-01T00:01:00.000Z',
          dedupeKey: 'skewed',
        }).deduped,
      ).toBe(false);
      // And an ordinary back-dated observation inside the open period.
      expect(
        recordUsage(ctx, { meter: 'ai.tokens.input', qty: '4', occurredAt: t(2), dedupeKey: 'back' })
          .deduped,
      ).toBe(false);
      expect(listEntries(ctx, { meter: 'ai.tokens.input' })).toHaveLength(4);
    }, ALL);
  });

  it('the forward bound moves with the clock, and does not disturb dedupe', async () => {
    const at = '2030-02-01T02:00:00.000Z';
    await h.run((ctx) => {
      expect(() =>
        recordUsage(ctx, { meter: 'ai.tokens.input', qty: '9', occurredAt: at, dedupeKey: 'turn-1' }),
      ).toThrow(/ahead of/);
    }, ALL);

    clock.set(at);
    await h.run((ctx) => {
      const first = recordUsage(ctx, {
        meter: 'ai.tokens.input',
        qty: '9',
        occurredAt: at,
        dedupeKey: 'turn-1',
      });
      expect(first.deduped).toBe(false);
      // A replay is answered from the existing row, before either bound is even
      // consulted — so the tightened window cannot turn a retry into an error.
      const replay = recordUsage(ctx, {
        meter: 'ai.tokens.input',
        qty: '9',
        occurredAt: '2032-01-01T00:00:00.000Z',
        dedupeKey: 'turn-1',
      });
      expect(replay.deduped).toBe(true);
      expect(replay.entry.id).toBe(first.entry.id);
    }, ALL);
    expect(h.eventsOfType('metering.usage-recorded')).toHaveLength(1);
  });

  it('normalizes instant precision so second- and millisecond-precision inputs compare correctly', async () => {
    await h.run((ctx) => {
      recordUsage(ctx, {
        meter: 'ai.tokens.input',
        qty: '7',
        occurredAt: '2030-01-02T00:00:00Z', // second precision in…
        dedupeKey: 'plain',
      });
      // …aggregates under millisecond-precision windows regardless
      expect(usageTotal(ctx, { meter: 'ai.tokens.input', from: t(1), to: t(3) })).toEqual({
        qty: '7',
        entryCount: 1,
      });
    }, ALL);
  });

  // -------------------------------------------------------------------------
  // Attribution subjects (D-F)
  // -------------------------------------------------------------------------

  it('entries may carry an opaque subject ref, filterable on read', async () => {
    await h.run((ctx) => {
      const project = { entityType: 'builder-project', entityId: 'proj-1' };
      recordUsage(ctx, { meter: 'ai.tokens.input', qty: '10', occurredAt: t(2), dedupeKey: 'p1', subject: project });
      recordUsage(ctx, { meter: 'ai.tokens.input', qty: '20', occurredAt: t(3), dedupeKey: 'p2' });
      const mine = listEntries(ctx, { subject: project });
      expect(mine).toHaveLength(1);
      expect(mine[0]!.subject).toEqual(project);
    }, ALL);
  });

  // -------------------------------------------------------------------------
  // Default operation bindings: default-deny
  // -------------------------------------------------------------------------

  it('operations default-deny; record permission does not grant close', async () => {
    const nobody = await h.as([]);
    await expect(nobody.invoke('metering/list-meters', undefined)).rejects.toThrow();

    const recorder = await h.as([PERM.record]);
    await expect(
      recorder.invoke('metering/record', {
        meter: 'ai.tokens.input',
        qty: '1',
        occurredAt: t(2),
        dedupeKey: 'op-1',
      }),
    ).resolves.toMatchObject({ deduped: false });
    await expect(
      recorder.invoke('metering/close-period', { from: t(1), to: t(10) }),
    ).rejects.toThrow();
  });
});
