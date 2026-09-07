import { describe, expect, it } from 'vitest';
import type { SweepRunEntry } from '@substrat-run/contracts';
import { SWEEP_WINDOW_MINUTES, deriveFreshnessHealth, deriveScheduleHealth } from '../src/schedules.js';

/**
 * The verdict table (#1232). Pure over its inputs, so every boundary the panel
 * will ever render is one row here — including the two that must never be
 * confused: a schedule that genuinely did not fire, and a sweeper that stopped
 * reaching the scope (whose silence must never blame the schedule).
 */
describe('deriveFreshnessHealth — the verdicts (#1272)', () => {
  const NOW = Date.parse('2026-09-07T12:00:00.000Z');
  const min = (n: number) => n * 60_000;
  const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
  const spec = (eventType: string, hours: number, moduleId = '@test/a') => ({
    eventType,
    within: { hours },
    moduleId,
  });
  const row = (msAgo: number, outcome: 'ok' | 'failed' | 'skipped', observedMsAgo: number | null): SweepRunEntry =>
    ({
      id: String(1e15 - msAgo),
      kind: 'freshness',
      unit: 'scope:receipt.landed',
      outcome,
      tenantId: null,
      scopeId: null,
      vertical: null,
      version: null,
      operation: null,
      connectionId: null,
      error: null,
      elapsedMs: null,
      eventType: 'receipt.landed',
      observedAt: observedMsAgo === null ? null : iso(observedMsAgo),
      at: iso(msAgo),
    }) as SweepRunEntry;
  const one = (rows: SweepRunEntry[], lastSweepAt: string | null, declared = [spec('receipt.landed', 24)]) =>
    deriveFreshnessHealth(declared as never, new Map([['receipt.landed', rows]]), lastSweepAt, NOW);

  it('the newest recorded verdict IS the verdict — fresh, stale, never-seen', () => {
    expect(one([row(min(40), 'ok', min(180))], iso(min(5)))[0]).toMatchObject({
      health: 'fresh',
      observedAt: iso(min(180)),
    });
    expect(one([row(min(40), 'failed', min(26 * 60))], iso(min(5)))[0]!.health).toBe('stale');
    expect(one([row(min(40), 'skipped', null)], iso(min(5)))[0]!.health).toBe('never-seen');
    expect(one([], iso(min(5)))[0]!.health).toBe('never-seen');
  });

  it("sweeper-silent replaces the verdict — a stopped evaluator is never the expectation's fault", () => {
    expect(one([row(min(40), 'failed', min(26 * 60))], null)[0]!.health).toBe('sweeper-silent');
    expect(one([row(min(40), 'ok', min(60))], iso(min(2 * SWEEP_WINDOW_MINUTES + 1)))[0]!.health).toBe(
      'sweeper-silent',
    );
  });

  it('duplicate declarations collapse to the tightest window — the panel shows what is judged', () => {
    const rows = one(
      [row(min(40), 'ok', min(60))],
      iso(min(5)),
      [spec('receipt.landed', 48, '@test/b'), spec('receipt.landed', 24, '@test/a')],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ withinHours: 24, moduleId: '@test/a' });
  });
});

describe('deriveScheduleHealth — the verdicts', () => {
  const NOW = Date.parse('2026-09-07T12:00:00.000Z');
  const min = (n: number) => n * 60_000;
  const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
  const spec = (operation: string, everyMinutes: number) => ({
    operation,
    cadence: { everyMinutes },
    permissions: [],
    moduleId: '@test/mod',
  });
  const run = (msAgo: number, outcome: 'ok' | 'failed' = 'ok', error: string | null = null): SweepRunEntry =>
    ({
      id: String(1e15 - msAgo), // newest first when sorted desc, like the route hands them
      kind: 'schedule',
      unit: 'scope:op',
      outcome,
      tenantId: null,
      scopeId: null,
      vertical: null,
      version: null,
      operation: 'op',
      connectionId: null,
      error,
      elapsedMs: null,
      at: iso(msAgo),
    }) as SweepRunEntry;

  const one = (
    everyMinutes: number,
    runs: SweepRunEntry[],
    lastSweepAt: string | null,
  ) =>
    // `as never`: the fixture writes plain strings where the contract carries brands —
    // the derivation is structural, and minting real brands here would test the parser.
    deriveScheduleHealth([spec('op', everyMinutes)] as never, new Map([['op', runs]]), lastSweepAt, NOW)[0]!;

  it('healthy: inside cadence + one sweep window, with next-due derived like the scheduler does', () => {
    const row = one(60, [run(min(30))], iso(min(5)));
    expect(row.health).toBe('healthy');
    expect(row.nextDueAt).toBe(iso(min(30 - 60))); // lastRun + 60m = 30m from now
    expect(row.lastRun!.outcome).toBe('ok');
  });

  it('one window late is still healthy — the grace is ADDITIVE, cadence + one sweep window', () => {
    // Due 10 minutes ago on a 60m cadence: inside the 15m window, so a cron gap,
    // not a missed run. A 2x-cadence grace would have called a five-minute
    // schedule late here and a daily one a full day later — both wrong ways.
    expect(one(60, [run(min(70))], iso(min(5))).health).toBe('healthy');
  });

  it('overdue: past next-due by more than one sweep window', () => {
    const row = one(60, [run(min(60 + SWEEP_WINDOW_MINUTES + 1))], iso(min(5)));
    expect(row.health).toBe('overdue');
  });

  it('never-run is its own verdict, not overdue — the scheduler treats it as immediately due', () => {
    const row = one(60, [], iso(min(5)));
    expect(row.health).toBe('never-run');
    expect(row.lastRun).toBeNull();
    expect(row.nextDueAt).toBeNull();
  });

  it("sweeper-silent replaces every verdict — an unreached scope is never the schedule's fault", () => {
    // The same rows that read 'overdue' above, but no sweep row of ANY outcome for
    // two windows: the loop stopped, and blaming the schedule would send the
    // operator to exactly the wrong place.
    expect(one(60, [run(min(200))], iso(min(2 * SWEEP_WINDOW_MINUTES + 1))).health).toBe('sweeper-silent');
    expect(one(60, [run(min(30))], null).health).toBe('sweeper-silent');
  });

  it('a failed last run stays a verdict about timing — the failure rides the row, verbatim', () => {
    const row = one(60, [run(min(30), 'failed', 'operation threw')], iso(min(5)));
    expect(row.health).toBe('healthy'); // it RAN — failing is the lastRun's fact, not lateness
    expect(row.lastRun).toMatchObject({ outcome: 'failed', error: 'operation threw' });
  });
});
