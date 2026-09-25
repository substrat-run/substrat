import type { AppFreshnessRow, AppScheduleRow, SweepRunView } from './api';
import { relativeTime } from './format';

/**
 * The pure half of the two schedule surfaces (#1767): Pulse's "Schedules and freshness"
 * section, where each schedule's runs sit on the page's time axis, and the App › Overview
 * card, where they sit in a fixed strip. Both render the verdicts the worker already
 * derived (`apps/dashboard/src/schedules.ts`) — nothing here re-judges a schedule, it only
 * places what was recorded and names it in the design's words.
 */

/**
 * How many runs one read returns per schedule: the worker merges its ok and failed reads
 * and caps them at 20 (`/apps/:id/schedules`). The design draws a 24-run strip; this read
 * has never held 24, so the strip is as long as the record rather than padded with four
 * slots that would read as "no run".
 */
export const RUN_CAP = 20;

export type BadgeStatus = 'success' | 'warning' | 'danger' | 'neutral';

/**
 * The derived verdicts, in the design's vocabulary:
 *
 *   healthy        → Healthy        (success)
 *   overdue        → Late           (warning) — past next-due by more than one sweep window
 *   never-run      → Never run      (neutral)
 *   sweeper-silent → Sweeper silent (warning) — no sweep reached the app, so not the schedule's fault
 *
 * A healthy schedule whose newest run FAILED stays Healthy: the worker judges timeliness,
 * not outcome, and the failure is carried by the Last run column and the red tick instead.
 */
export const SCHEDULE_VERDICT: Record<AppScheduleRow['health'], { status: BadgeStatus; label: string }> = {
  healthy: { status: 'success', label: 'Healthy' },
  overdue: { status: 'warning', label: 'Late' },
  'never-run': { status: 'neutral', label: 'Never run' },
  'sweeper-silent': { status: 'warning', label: 'Sweeper silent' },
};

/**
 * Freshness verdicts. The design names only Fresh and Stale for these; `never-seen` is the
 * never-run analogue, and saying "Never run" of an event type would describe a schedule,
 * so it keeps its own words.
 *
 *   fresh          → Fresh          (success)
 *   stale          → Stale          (danger)  — Pulse appends the age: "Stale 26h"
 *   never-seen     → Never seen     (neutral)
 *   sweeper-silent → Sweeper silent (warning)
 */
export const FRESHNESS_VERDICT: Record<AppFreshnessRow['health'], { status: BadgeStatus; label: string }> = {
  fresh: { status: 'success', label: 'Fresh' },
  stale: { status: 'danger', label: 'Stale' },
  'never-seen': { status: 'neutral', label: 'Never seen' },
  'sweeper-silent': { status: 'warning', label: 'Sweeper silent' },
};

export const cadenceLabel = (min: number): string =>
  min % 1440 === 0 && min >= 1440
    ? `every ${min / 1440 === 1 ? 'day' : `${min / 1440} days`}`
    : min % 60 === 0 && min >= 60
      ? `every ${min / 60 === 1 ? 'hour' : `${min / 60} hours`}`
      : `every ${min} min`;

const DAY_MS = 86_400_000;

/**
 * A 24-hour clock time, in UTC: the Observability page labels its chart, its window and
 * its log lines in UTC, and an axis under that chart in local time would put the same run
 * at two different hours on one screen.
 */
export const clock = (iso: string): string =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' });

/**
 * When something happened, as short as a 96px mono column allows: the clock time within
 * the last day, and the relative age past it — a bare "15:45" from three days ago would
 * read as this afternoon.
 */
export function when(iso: string, now = Date.now()): string {
  return now - Date.parse(iso) < DAY_MS ? clock(iso) : relativeTime(iso, now);
}

/** An elapsed span, compact: "22 min", "26h", "3d". */
export function span(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/** The newest firing, for the Last run column: "15:45", "failed 15:38", "never". */
export function lastRunLabel(row: AppScheduleRow, now = Date.now()): { text: string; failed: boolean } {
  if (row.lastRun === null) return { text: row.health === 'never-run' ? 'never' : '—', failed: false };
  const failed = row.lastRun.outcome === 'failed';
  return { text: `${failed ? 'failed ' : ''}${when(row.lastRun.at, now)}`, failed };
}

/** The overview card's Last run cell: "ok · 15:45", "failed · 15:38", "never". */
export function lastRunCell(row: AppScheduleRow, now = Date.now()): { text: string; failed: boolean } {
  if (row.lastRun === null) return { text: row.health === 'never-run' ? 'never' : '—', failed: false };
  return { text: `${row.lastRun.outcome} · ${when(row.lastRun.at, now)}`, failed: row.lastRun.outcome === 'failed' };
}

/**
 * The overview card's run strip: always RUN_CAP slots, oldest first, the newest at the
 * right edge. A schedule that has fired fewer times than that is padded on the LEFT with
 * empty slots — the runs that never happened are the old ones.
 */
export function stripSlots(runs: SweepRunView[]): Array<SweepRunView | null> {
  const recent = [...runs.slice(0, RUN_CAP)].reverse();
  return [...Array.from({ length: RUN_CAP - recent.length }, () => null), ...recent];
}

export interface AxisWindow {
  from: string;
  to: string;
}

/** Where an instant falls on the axis, 0–1, or null when it lies outside the window. */
export function place(iso: string, w: AxisWindow): number | null {
  const t = Date.parse(iso),
    a = Date.parse(w.from),
    b = Date.parse(w.to);
  if (!(b > a) || t < a || t > b) return null;
  return (t - a) / (b - a);
}

/** A hatched span, from its start to the axis' right edge: a state that began and has not ended. */
export interface Hatch {
  from: number;
  title: string;
}

/** Everything the Pulse row draws for one schedule over the window. */
export interface PulseScheduleRow {
  row: AppScheduleRow;
  /** Runs recorded inside the window. */
  runs: number;
  failed: number;
  /**
   * The read holds only the last RUN_CAP runs, so when the oldest of them is itself inside
   * the window, runs before it may also fall inside — the counts are lower bounds, and the
   * axis left of `coveredFrom` is not what the schedule did but what the read reached.
   */
  truncated: boolean;
  coveredFrom: number | null;
  ticks: Tick[];
  hatch: Hatch | null;
}

const hatchFrom = (iso: string | null, w: AxisWindow): number | null => {
  if (iso === null) return 0;
  if (Date.parse(iso) < Date.parse(w.from)) return 0;
  return place(iso, w);
};

type Tick = { id: string; x: number; failed: boolean; title: string };

/** What a run history draws over the window: the counts, the ticks, and how far the read reaches. */
function runMarks(runs: SweepRunView[], w: AxisWindow) {
  const inside = runs.filter((r) => place(r.at, w) !== null);
  const oldest = runs.at(-1);
  // A run exactly on the left edge places at 0 and is inside: any placement counts.
  const oldestX = oldest ? place(oldest.at, w) : null;
  const truncated = runs.length >= RUN_CAP && oldestX !== null;
  const ticks: Tick[] = inside.map((r) => ({
    id: r.id,
    x: place(r.at, w)!,
    failed: r.outcome === 'failed',
    title: `${r.outcome === 'failed' ? `failed${r.error ? `: ${r.error}` : ''}` : r.outcome} · ${clock(r.at)}`,
  }));
  return {
    runs: inside.length,
    failed: inside.filter((r) => r.outcome === 'failed').length,
    truncated,
    coveredFrom: truncated ? oldestX : null,
    ticks,
  };
}

export function pulseScheduleRow(row: AppScheduleRow, w: AxisWindow, lastSweepAt: string | null): PulseScheduleRow {
  const marks = runMarks(row.runs, w);
  let hatch: Hatch | null = null;
  if (row.health === 'overdue' && row.nextDueAt) {
    const x = hatchFrom(row.nextDueAt, w);
    if (x !== null) hatch = { from: x, title: `Due since ${clock(row.nextDueAt)} — ${cadenceLabel(row.everyMinutes)}` };
  } else if (row.health === 'sweeper-silent') {
    const x = hatchFrom(lastSweepAt, w);
    if (x !== null) hatch = { from: x, title: lastSweepAt ? `No sweep since ${clock(lastSweepAt)}` : 'No sweep has reached this app' };
  }
  return { row, ...marks, hatch };
}

/** Pulse's freshness row: the age of the newest evidence, and the span it has been stale. */
export function pulseFreshnessRow(
  row: AppFreshnessRow,
  w: AxisWindow,
  lastSweepAt: string | null,
  now = Date.now(),
): { age: string; verdict: string; hatch: Hatch | null } & Omit<PulseScheduleRow, 'row' | 'hatch'> {
  const age = row.observedAt ? relativeTime(row.observedAt, now) : row.health === 'never-seen' ? 'never' : '—';
  let hatch: Hatch | null = null;
  let verdict = FRESHNESS_VERDICT[row.health].label;
  if (row.health === 'stale') {
    // Stale from the moment the window lapsed: the last evidence plus the declared bound.
    const since = row.observedAt ? new Date(Date.parse(row.observedAt) + row.withinHours * 3_600_000).toISOString() : null;
    const x = hatchFrom(since, w);
    if (x !== null) hatch = { from: x, title: freshnessSentence(row, now) };
    if (row.observedAt) verdict = `Stale ${span(now - Date.parse(row.observedAt))}`;
  } else if (row.health === 'sweeper-silent') {
    const x = hatchFrom(lastSweepAt, w);
    if (x !== null) hatch = { from: x, title: lastSweepAt ? `No sweep since ${clock(lastSweepAt)}` : 'No sweep has reached this app' };
  }
  return { age, verdict, hatch, ...runMarks(row.runs, w) };
}

/** One freshness rule, as a sentence: the line this feature exists to produce. */
export function freshnessSentence(row: AppFreshnessRow, now = Date.now()): string {
  if (row.health === 'never-seen' || row.observedAt === null) {
    return `No ${row.eventType} has ever landed here`;
  }
  if (row.health === 'stale') return `No ${row.eventType} for ${span(now - Date.parse(row.observedAt))} and counting`;
  if (row.health === 'sweeper-silent') return `Last ${row.eventType} ${relativeTime(row.observedAt, now)} — not checked since the sweep went quiet`;
  return `${row.eventType} arrived ${relativeTime(row.observedAt, now)}`;
}

/**
 * Rows with a run inside a narrowed window come first — hoisted, never filtered: a
 * schedule with no run in the window is still a schedule, and dropping it would make
 * "none of them fired then" read as "this app has fewer schedules". Stable otherwise.
 */
export function hoistInWindow(rows: AppScheduleRow[], w: AxisWindow): AppScheduleRow[] {
  const hit = (r: AppScheduleRow) => Number(r.runs.some((x) => place(x.at, w) !== null));
  return [...rows].sort((a, b) => hit(b) - hit(a));
}

/** Axis labels: seven, evenly spaced, the last reading "now" when the window ends now. */
export function axisLabels(w: AxisWindow, now = Date.now()): Array<{ left: number; label: string }> {
  const a = Date.parse(w.from),
    b = Date.parse(w.to);
  const long = b - a > DAY_MS;
  return Array.from({ length: 7 }, (_, i) => {
    const t = a + ((b - a) * i) / 6;
    const iso = new Date(t).toISOString();
    const label =
      i === 6 && now - b < 120_000
        ? 'now'
        : long
          ? `${new Date(t).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })} ${clock(iso)}`
          : clock(iso);
    return { left: i / 6, label };
  });
}
