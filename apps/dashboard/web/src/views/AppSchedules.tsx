import { useEffect, useState } from 'react';
import { api, type AppSchedulesView, type AppScheduleRow, type AppFreshnessRow } from '../lib/api';
import { DEV_MOCK, MOCK_APP_SCHEDULES } from '../lib/mock';
import { Pill, SweepStrip, card, type PillKind } from '../components/ui';
import { relativeTime, untilTime } from '../lib/format';

/**
 * Schedule health for one app (#1232): every schedule the RUNNING version declares,
 * with the verdict the worker derived — the panel a missed run appears on, since a
 * missed run raises no error anywhere else. Hidden entirely when the version
 * declares none (most verticals) or predates the manifest field (the field arrives
 * free on the next push — a nag on every app would outnumber the feature).
 */

const HEALTH: Record<AppScheduleRow['health'], { kind: PillKind; label: string }> = {
  healthy: { kind: 'success', label: 'On schedule' },
  overdue: { kind: 'danger', label: 'Overdue' },
  'never-run': { kind: 'neutral', label: 'Never run' },
  'sweeper-silent': { kind: 'warning', label: 'No sweep data' },
};

const FRESHNESS: Record<AppFreshnessRow['health'], { kind: PillKind; label: string }> = {
  fresh: { kind: 'success', label: 'Fresh' },
  stale: { kind: 'danger', label: 'Stale' },
  'never-seen': { kind: 'neutral', label: 'Never seen' },
  'sweeper-silent': { kind: 'warning', label: 'No sweep data' },
};

function freshnessLine(row: AppFreshnessRow): string {
  if (row.health === 'never-seen') {
    return `No ${row.eventType} has ever landed here. Expected within ${row.withinHours}h once the flow is live.`;
  }
  if (row.observedAt === null) return '';
  if (row.health === 'stale') {
    // The sentence this whole feature exists to produce.
    return `No ${row.eventType} ${relativeTime(row.observedAt).replace(' ago', '')} and counting — expected within ${row.withinHours}h.`;
  }
  return `Last ${row.eventType} ${relativeTime(row.observedAt)} · expected within ${row.withinHours}h`;
}

const cadenceLabel = (min: number): string =>
  min % 1440 === 0 && min >= 1440
    ? `every ${min / 1440 === 1 ? 'day' : `${min / 1440} days`}`
    : min % 60 === 0 && min >= 60
      ? `every ${min / 60 === 1 ? 'hour' : `${min / 60} hours`}`
      : `every ${min} min`;

function statusLine(row: AppScheduleRow): string {
  if (row.health === 'never-run') {
    return 'Never run. The first sweep pass after this app went live fires it.';
  }
  if (row.lastRun === null) return '';
  const ran =
    row.lastRun.outcome === 'failed'
      ? `Failed ${relativeTime(row.lastRun.at)}: ${row.lastRun.error ?? 'no error recorded'}`
      : `Last run ${relativeTime(row.lastRun.at)}`;
  if (row.health === 'overdue' && row.nextDueAt) {
    return `Due ${relativeTime(row.nextDueAt)} — ${ran.toLowerCase()}, ${cadenceLabel(row.everyMinutes)}.`;
  }
  return row.nextDueAt ? `${ran} · next due ${untilTime(row.nextDueAt)}` : ran;
}

/** A cursor's endpoints, short — a reminder of where the page is looking, not a timestamp. */
const shortTime = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/**
 * Schedule health for one app, optionally answering a time cursor (#1447 step 3c).
 *
 * `window` is the minutes a failed-run marker on the chart named. A marker click that
 * merely opened this panel would leave the reader to find the run among twenty ticks
 * per schedule — so the schedules with a run inside the window are hoisted, that run is
 * named on the row's own line, and its tick is ringed. Nothing is hidden: a schedule
 * with no run in the window is still a schedule, and dropping it would make "none of
 * them fired then" look like "this app has fewer schedules". When no run at all falls
 * inside, the panel says so, and says why it might — the strip keeps the last twenty
 * runs, so an old cursor can name minutes the strip no longer reaches.
 */
export function AppSchedules({ scopeId, window }: { scopeId: string; window?: { from: string; to: string } }) {
  const [view, setView] = useState<AppSchedulesView | null>(null);

  useEffect(() => {
    // Cleared first: keeping the previous app's rows visible while the next app's
    // request is in flight would caption one app with another's schedules.
    setView(null);
    if (DEV_MOCK) {
      setView(MOCK_APP_SCHEDULES);
      return;
    }
    let live = true;
    // Best-effort: a worker predating the route means no panel, never an error —
    // the tab's other panels answer their own questions independently.
    api
      .appSchedules(scopeId)
      .then((v) => live && setView(v))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [scopeId]);

  const freshness = view?.freshness ?? [];
  // The runs inside the window, per schedule — ISO strings compare as instants.
  const inWindow = (at: string): boolean => !!window && at >= window.from && at <= window.to;
  const hits = new Map<AppScheduleRow, AppScheduleRow['runs']>(
    (view?.schedules ?? []).map((row) => [row, row.runs.filter((r) => inWindow(r.at))]),
  );
  const ringed = new Set([...hits.values()].flat().map((r) => r.id));
  // Hoisted, not filtered: the rows with a run in the window come first, in their own
  // order; every other row keeps its place after them.
  const schedules = window
    ? [...(view?.schedules ?? [])].sort((a, b) => Number((hits.get(b)?.length ?? 0) > 0) - Number((hits.get(a)?.length ?? 0) > 0))
    : (view?.schedules ?? []);
  if (!view || (schedules.length === 0 && freshness.length === 0)) return null;
  const silent = [...schedules, ...freshness].every((s) => s.health === 'sweeper-silent');

  return (
    <div style={{ ...card, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Schedules</div>
      {silent && view.lastSweepAt !== null && (
        <div style={{ fontSize: 12, color: 'var(--status-warning-fg)' }}>
          No sweep has reached this app since {relativeTime(view.lastSweepAt)}. Nothing below is the
          schedule&apos;s fault yet.
        </div>
      )}
      {silent && view.lastSweepAt === null && (
        <div style={{ fontSize: 12, color: 'var(--status-warning-fg)' }}>
          No sweep has reached this app yet — schedule health appears after the first pass.
        </div>
      )}
      {window && schedules.length > 0 && ringed.size === 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
          No run of any schedule is recorded between {shortTime(window.from)} and {shortTime(window.to)}.
          Each strip keeps the last {Math.max(...schedules.map((r) => r.runs.length), 0)} runs, so an
          older window may lie past what it reaches.
        </div>
      )}
      {schedules.map((row) => (
        <div key={`${row.moduleId}:${row.operation}`} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {/* Silent suppresses the per-row verdicts entirely — the banner already
                said why, and ten identical "No sweep data" pills would restate it as noise. */}
            {!silent && <Pill kind={HEALTH[row.health].kind}>{HEALTH[row.health].label}</Pill>}
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-primary)' }}>
              {row.operation}
            </span>
            <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{cadenceLabel(row.everyMinutes)}</span>
          </div>
          {!silent && (
            <div
              style={{
                fontSize: 11.5,
                color:
                  row.health === 'overdue' || row.lastRun?.outcome === 'failed'
                    ? 'var(--status-danger-fg)'
                    : 'var(--text-tertiary)',
              }}
            >
              {statusLine(row)}
            </div>
          )}
          {(hits.get(row) ?? []).map((r) => (
            // The run the cursor landed on, in words: what the click was for.
            <div key={r.id} style={{ fontSize: 11.5, color: r.outcome === 'failed' ? 'var(--status-danger-fg)' : 'var(--text-secondary)' }}>
              In this window: {r.outcome === 'failed' ? `failed ${shortTime(r.at)}: ${r.error ?? 'no error recorded'}` : `${r.outcome} ${shortTime(r.at)}`}
            </div>
          ))}
          <SweepStrip runs={row.runs} label="Last run" skippedNote="not due yet" ringed={ringed} />
        </div>
      ))}
      {freshness.length > 0 && (
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginTop: 4 }}>Freshness</div>
      )}
      {freshness.map((row) => (
        <div key={`fresh:${row.eventType}`} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {!silent && <Pill kind={FRESHNESS[row.health].kind}>{FRESHNESS[row.health].label}</Pill>}
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-primary)' }}>
              {row.eventType}
            </span>
            <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>within {row.withinHours}h</span>
          </div>
          {!silent && (
            <div
              style={{
                fontSize: 11.5,
                color: row.health === 'stale' ? 'var(--status-danger-fg)' : 'var(--text-tertiary)',
              }}
            >
              {freshnessLine(row)}
            </div>
          )}
          {/* Sparse by design: freshness writes on verdict change + an hourly
              heartbeat, so each tick is a state transition or a pulse, never noise. */}
          <SweepStrip runs={row.runs} label="Last check" skippedNote="no event of this type yet" />
        </div>
      ))}
    </div>
  );
}
