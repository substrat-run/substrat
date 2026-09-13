import type { OpsFailureEntry, SweepRunEntry } from '@substrat-run/contracts';
import { bucketGrid, bucketMinutesFor } from './releases.js';

/**
 * The overlays an app's traffic chart draws (#1447 step 3b) — the declared facts that
 * EXPLAIN the shape, never an inferred anomaly. Every one of them is an exact instant
 * already in the record: a migration's `applied_at`, a sweep row's outcome, a recorded
 * failure's `at`. Nothing here decides that traffic looks wrong; it says what happened
 * at that moment, and the reader does the joining.
 *
 * Pure over its inputs for the reason every derivation in this directory is: the rules
 * below — which instants count, how long a stale window lasts, which marker survives the
 * cap — are the whole feature, and a rule that cannot be table-tested is a rule nobody
 * trusts.
 */

/** One instant worth a glyph. */
export interface OverlayMarker {
  at: string;
  kind: 'migration' | 'run-failed' | 'failure';
  label: string;
  /** The one line of context the tooltip adds, or the honest absence of one. */
  detail: string | null;
}

/** A stretch of time worth shading — today only a freshness expectation reading stale. */
export interface OverlaySpan {
  from: string;
  to: string;
  kind: 'stale';
  label: string;
}

export interface AppOverlays {
  markers: OverlayMarker[];
  spans: OverlaySpan[];
  /** True = markers were dropped to the cap; the legend says so rather than hiding it. */
  truncated: boolean;
}

/**
 * How many markers a chart draws before it stops and counts. A burst of failures can run
 * to thousands of rows, and past a few hundred glyphs the chart stops being readable
 * while the payload keeps growing.
 */
export const OVERLAY_MARKER_CAP = 300;

/** How much of a failure's message a tooltip carries — the first line's worth. */
const DETAIL_CHARS = 120;

/**
 * The window the overlays cover, as epoch ms — the SAME grid the traffic series is drawn
 * on, not `now - hours`. The series snaps its start back to a bucket boundary
 * (`bucketGrid`), so its first column can begin up to a bucket before the exact request
 * time; a window that started at the request time would drop every marker in that
 * column's opening minutes and clip a stale span the same distance into the visible
 * chart. `end` is the clock, since no recorded instant lies past it. The worker windows
 * its reads with this too, so what is fetched and what is drawn agree.
 */
export function overlayWindow(hours: number, now: Date): { start: number; end: number } {
  return { start: bucketGrid(bucketMinutesFor(hours), hours, now).start, end: now.getTime() };
}

/** One applied migration, as the plane's schema-history read delivers it. */
interface AppliedMigrationInput {
  moduleId: string;
  version: string;
  /** Null for a row written before the platform recorded the instant. */
  appliedAt: string | null;
}

export function deriveAppOverlays(input: {
  migrations: AppliedMigrationInput[];
  sweepRuns: SweepRunEntry[];
  failures: OpsFailureEntry[];
  /** The app the chart is about. The reads are narrowed to it upstream; this is the check that they were. */
  scopeId: string;
  hours: number;
  /** The window's end — the caller's clock, so the overlays and the series agree. */
  now: Date;
}): AppOverlays {
  const { migrations, sweepRuns, failures, scopeId, hours, now } = input;
  const { start, end } = overlayWindow(hours, now);
  const at = (iso: string | null): number => (iso === null ? NaN : Date.parse(iso));
  const inWindow = (iso: string | null): boolean => {
    const t = at(iso);
    return !Number.isNaN(t) && t >= start && t <= end;
  };

  const markers: OverlayMarker[] = [];

  // #1320 ruled migrations out as markers on the FLEET chart, and was right to: a
  // migration runs per scope while the script it belongs to serves many, so a line on
  // that chart would claim an instant most of its traffic never had. This chart is one
  // scope, so the objection disappears — it is the one place a migration is an honest
  // marker. A row with no `appliedAt` predates the recording of the instant: no instant,
  // no marker, and the Schema history list still shows it.
  for (const m of migrations) {
    if (!inWindow(m.appliedAt)) continue;
    markers.push({ at: m.appliedAt!, kind: 'migration', label: `${m.moduleId} ${m.version}`, detail: null });
  }

  // A failed schedule run is a fact with an instant; a skipped one is the CP-less pass
  // saying it had nothing to do, and would bury the chart in glyphs for no finding.
  for (const r of sweepRuns) {
    if (r.kind !== 'schedule' || r.outcome !== 'failed' || !inWindow(r.at)) continue;
    markers.push({ at: r.at, kind: 'run-failed', label: r.unit, detail: r.error });
  }

  // The worker reads failures narrowed to this scope; the check stays here because the
  // consequence of a row slipping through is drawing another installation's incident on
  // this app's chart, and a rule that grave belongs where the table test can reach it.
  for (const f of failures) {
    if (f.scopeId !== scopeId || !inWindow(f.at)) continue;
    markers.push({
      at: f.at,
      kind: 'failure',
      label: f.stage ? `${f.operation} · ${f.stage}` : f.operation,
      detail: (f.code ?? f.message).slice(0, DETAIL_CHARS),
    });
  }

  markers.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  // The newest is what a reader came for — they opened the chart because something is
  // wrong NOW — so the cap keeps the tail and the legend admits the head was dropped.
  const truncated = markers.length > OVERLAY_MARKER_CAP;

  return {
    markers: truncated ? markers.slice(-OVERLAY_MARKER_CAP) : markers,
    spans: staleSpans(sweepRuns, start, end, now),
    truncated,
  };
}

/**
 * The stale windows, per freshness unit. Freshness rows are CHANGE-GATED — the evaluator
 * writes one when the verdict moves, not on every pass — so a single `failed` row means
 * "stale from here until something says otherwise". That is a span, not a point, and
 * drawing it as a point would tell the reader an expectation recovered the instant it
 * broke.
 *
 * `skipped` neither opens nor closes: it means no event of this type has ever landed, and
 * never-seen is not stale — a brand-new install must not shade its whole chart.
 *
 * Because the rows are change-gated, the read behind this must NOT be windowed to the
 * chart: an expectation that went stale last week and has not recovered has exactly one
 * row, last week's, and a `since` at the window's start would drop it — the app reads
 * healthy for as long as nothing changes, which is the opposite of what happened. The
 * worker reads freshness rows unwindowed (there are as many as there were verdict
 * changes, not passes), and this function windows the SPANS, not the rows.
 */
function staleSpans(sweepRuns: SweepRunEntry[], start: number, end: number, now: Date): OverlaySpan[] {
  const byUnit = new Map<string, SweepRunEntry[]>();
  for (const r of sweepRuns) {
    if (r.kind !== 'freshness' || Number.isNaN(Date.parse(r.at))) continue;
    byUnit.set(r.unit, [...(byUnit.get(r.unit) ?? []), r]);
  }

  const spans: OverlaySpan[] = [];
  // Clipped, not dropped: a window already stale when the chart's window began must
  // still be shaded from its left edge, or the reader concludes the app was healthy up
  // to the first row they can see. A span lying wholly outside the window is dropped.
  const push = (open: { from: number; label: string }, to: number): void => {
    if (to <= start || open.from > end) return;
    spans.push({
      from: new Date(Math.max(open.from, start)).toISOString(),
      to: new Date(Math.min(to, end)).toISOString(),
      kind: 'stale',
      label: open.label,
    });
  };

  for (const [unit, rows] of byUnit) {
    const ordered = [...rows].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    let open: { from: number; label: string } | null = null;
    for (const r of ordered) {
      const t = Date.parse(r.at);
      if (r.outcome === 'failed') {
        if (open === null) open = { from: t, label: r.eventType ?? unit };
      } else if (r.outcome === 'ok' && open !== null) {
        push(open, t);
        open = null;
      }
    }
    // Still open at the end of the record = still stale: the span runs to now.
    if (open !== null) push(open, now.getTime());
  }

  return spans.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
}
