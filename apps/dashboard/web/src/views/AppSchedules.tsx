import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Badge } from '@substrat-run/ui';
import { api, type AppSchedulesView } from '../lib/api';
import { DEV_MOCK } from '../lib/mock';
import { MOCK_SCHEDULES_VIEW } from '../lib/mock-schedules';
import { card } from '../components/ui';
import { relativeTime } from '../lib/format';
import { navigate, obsPath, teamPath } from '../lib/router';
import type { ObsQuery } from '../lib/observability-query';
import {
  FRESHNESS_VERDICT,
  RUN_CAP,
  SCHEDULE_VERDICT,
  axisLabels,
  cadenceLabel,
  clock,
  hoistInWindow,
  lastRunLabel,
  pulseFreshnessRow,
  pulseScheduleRow,
  type Hatch,
} from '../lib/schedule-rows';

/**
 * Pulse › Schedules and freshness (#1232, restyled for #1767): every schedule the RUNNING
 * version declares, with the verdict the worker derived, and its runs drawn at their real
 * times on the page's own time axis — the panel a missed run appears on, since a missed
 * run raises no error anywhere else. Hidden entirely when the version declares none (most
 * verticals) or predates the manifest field (the field arrives free on the next push — a
 * nag on every app would outnumber the feature).
 */

/** The one-clock card's grid (the prototype's Pulse table): name, three numbers, the axis, the verdict. */
const GRID = '200px 96px 96px 96px minmax(0,1fr) 140px';

/** Five minutes either side of a run — the same pad the chart's markers open Logs with. */
const aroundRun = (at: string) => {
  const t = Date.parse(at);
  return { from: new Date(t - 5 * 60_000).toISOString(), to: new Date(t + 5 * 60_000).toISOString() };
};

/**
 * Schedule health for one app on the page's time axis.
 *
 * `window` is the axis — the page's current range, or the minutes a cursor narrowed it to.
 * With `focused` (the page carries an explicit from/to, e.g. a failed-run marker's minutes)
 * the section answers that window: schedules with a run inside it are hoisted and the run is
 * named on the row's own line. Nothing is hidden: a schedule with no run in the window is
 * still a schedule. When no run at all falls inside, the section says so, and says why it
 * might — the read keeps the last twenty runs, so an old window can name minutes the record
 * no longer reaches.
 */
export function AppSchedules({
  scopeId,
  window,
  focused = false,
  appName,
  onOpen,
}: {
  scopeId: string;
  window: { from: string; to: string };
  focused?: boolean;
  appName?: string;
  /** Narrow the page — the row's link. Absent: the row's href is followed as a plain navigation. */
  onOpen?: (q: ObsQuery) => void;
}) {
  const [view, setView] = useState<AppSchedulesView | null>(null);

  useEffect(() => {
    // Cleared first: keeping the previous app's rows visible while the next app's
    // request is in flight would caption one app with another's schedules.
    setView(null);
    if (DEV_MOCK) {
      setView(MOCK_SCHEDULES_VIEW);
      return;
    }
    let live = true;
    // Best-effort: a worker predating the route means no panel, never an error —
    // the page's other panels answer their own questions independently.
    api
      .appSchedules(scopeId)
      .then((v) => live && setView(v))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [scopeId]);

  const freshness = view?.freshness ?? [];
  const declared = view?.schedules ?? [];
  if (!view || (declared.length === 0 && freshness.length === 0)) return null;
  const schedules = (focused ? hoistInWindow(declared, window) : declared).map((row) =>
    pulseScheduleRow(row, window, view.lastSweepAt),
  );
  const silent = [...declared, ...freshness].every((s) => s.health === 'sweeper-silent');
  const anyRunInside = schedules.some((s) => s.runs > 0);
  const now = Date.now();
  const sub = (rest: string) => (appName ? `${appName} · ${rest}` : rest);
  const open = (q: ObsQuery) => ({
    href: teamPath(obsPath({ app: scopeId, ...q })),
    go: () => (onOpen ? onOpen(q) : navigate(obsPath({ app: scopeId, ...q }))),
  });

  return (
    <div style={{ ...card, boxShadow: 'var(--shadow-sm)', overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', padding: '0 16px', height: 32, fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>
        <span>Schedules and freshness</span>
        <span style={num}>Last run</span>
        <span style={num}>Runs</span>
        <span style={num}>Failed</span>
        <span>Runs on the same clock · × failed</span>
        <span style={{ textAlign: 'right' }}>Verdict</span>
      </div>
      {silent && (
        <Note tone="warning">
          {view.lastSweepAt !== null
            ? `No sweep has reached this app since ${relativeTime(view.lastSweepAt)}. Nothing below is the schedule's fault yet.`
            : 'No sweep has reached this app yet — schedule health appears after the first pass.'}
        </Note>
      )}
      {focused && schedules.length > 0 && !anyRunInside && (
        <Note>
          No run of any schedule is recorded between {clock(window.from)} and {clock(window.to)}. Each schedule
          keeps its last {RUN_CAP} runs here, so an older window may lie past what the record reaches.
        </Note>
      )}
      {schedules.map((s) => {
        const { row } = s;
        const last = lastRunLabel(row, now);
        const v = SCHEDULE_VERDICT[row.health];
        // The run the cursor landed on, in words: what a focused window is for.
        const hit = focused ? row.runs.find((r) => s.ticks.some((t) => t.id === r.id)) : undefined;
        const link = row.lastRun ? open({ view: 'logs', ...aroundRun(row.lastRun.at) }) : null;
        const lowerBound = s.truncated ? '+' : '';
        return (
          <RowLink key={`${row.moduleId}:${row.operation}`} link={link} title={link ? 'Logs around the last run' : undefined}>
            <Name
              name={row.operation}
              sub={
                hit
                  ? `In this window: ${hit.outcome === 'failed' ? `failed ${clock(hit.at)}: ${hit.error ?? 'no error recorded'}` : `${hit.outcome} ${clock(hit.at)}`}`
                  : sub(cadenceLabel(row.everyMinutes))
              }
              subColor={hit?.outcome === 'failed' ? 'var(--status-danger-fg)' : undefined}
            />
            <span style={{ ...num, ...mono, color: last.failed ? 'var(--status-danger-fg)' : undefined }}>{last.text}</span>
            <span style={{ ...num, ...mono }} title={s.truncated ? `At least — only the last ${RUN_CAP} runs are read` : undefined}>
              {row.health === 'never-run' ? '0' : `${s.runs}${lowerBound}`}
            </span>
            <span
              style={{ ...num, ...mono, color: s.failed > 0 ? 'var(--status-danger-fg)' : 'var(--text-secondary)' }}
              title={s.truncated ? `At least — only the last ${RUN_CAP} runs are read` : undefined}
            >
              {row.health === 'never-run' ? '—' : `${s.failed}${lowerBound}`}
            </span>
            <Axis hatch={s.hatch} coveredFrom={s.coveredFrom}>
              {s.ticks.map((t) => (
                <RunTick key={t.id} t={t} />
              ))}
            </Axis>
            <span style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Badge status={v.status}>{v.label}</Badge>
            </span>
          </RowLink>
        );
      })}
      {freshness.map((row) => {
        const f = pulseFreshnessRow(row, window, view.lastSweepAt, now);
        const v = FRESHNESS_VERDICT[row.health];
        const link = open({ view: 'events', type: row.eventType, ...(focused ? window : {}) });
        return (
          <RowLink key={`fresh:${row.eventType}`} link={link} title={`${row.eventType} in the event explorer`}>
            <Name name={row.eventType} sub={sub(`freshness · ≤ ${row.withinHours}h`)} />
            <span style={{ ...num, ...mono, color: row.health === 'stale' ? 'var(--status-warning-fg)' : undefined }}>{f.age}</span>
            <span style={{ ...num, ...mono }} title={f.truncated ? `At least — only the last ${RUN_CAP} runs are read` : undefined}>
              {f.runs}
              {f.truncated ? '+' : ''}
            </span>
            <span
              style={{ ...num, ...mono, color: f.failed > 0 ? 'var(--status-danger-fg)' : 'var(--text-secondary)' }}
              title={f.truncated ? `At least — only the last ${RUN_CAP} runs are read` : undefined}
            >
              {f.failed}
              {f.truncated ? '+' : ''}
            </span>
            <Axis hatch={f.hatch} coveredFrom={f.coveredFrom}>
              {f.ticks.map((t) => (
                <RunTick key={t.id} t={t} />
              ))}
            </Axis>
            <span style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Badge status={v.status}>{f.verdict}</Badge>
            </span>
          </RowLink>
        );
      })}
      <div style={{ display: 'grid', gridTemplateColumns: GRID, padding: '0 16px', height: 28, borderTop: '1px solid var(--border-default)' }}>
        <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 2, height: 10, background: 'var(--text-tertiary)' }} />run
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 2, height: 12, background: 'var(--status-danger-fg)' }} />failed
          </span>
          <span>UTC</span>
        </span>
        <span />
        <span />
        <span />
        <span style={{ position: 'relative' }}>
          {axisLabels(window, now).map((t) => (
            <span
              key={t.left}
              style={{
                position: 'absolute',
                left: `${(t.left * 100).toFixed(2)}%`,
                top: 6,
                // The end labels stay inside the axis rather than hanging past its edges.
                transform: t.left === 0 ? 'none' : t.left === 1 ? 'translateX(-100%)' : 'translateX(-50%)',
                fontFamily: 'var(--font-mono)',
                fontSize: 10.5,
                color: 'var(--text-tertiary)',
                whiteSpace: 'nowrap',
              }}
            >
              {t.label}
            </span>
          ))}
        </span>
        <span />
      </div>
    </div>
  );
}

const num: CSSProperties = { textAlign: 'right', paddingRight: 16 };
const mono: CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 13 };

const rowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: GRID,
  alignItems: 'center',
  padding: '0 16px',
  height: 48,
  borderTop: '1px solid var(--border-subtle)',
  color: 'var(--text-primary)',
  textDecoration: 'none',
};

/** A row, as a real link when it has somewhere to go. A never-run schedule has no run to open. */
function RowLink({ link, title, children }: { link: { href: string; go: () => void } | null; title?: string | undefined; children: ReactNode }) {
  const [hover, setHover] = useState(false);
  if (!link) return <div style={rowStyle}>{children}</div>;
  return (
    <a
      href={link.href}
      title={title}
      onClick={(e) => {
        e.preventDefault();
        link.go();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ ...rowStyle, cursor: 'pointer', background: hover ? 'var(--surface-hover)' : undefined }}
    >
      {children}
    </a>
  );
}

function Name({ name, sub, subColor }: { name: string; sub: string; subColor?: string | undefined }) {
  return (
    <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <span style={{ fontSize: 13.5, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={name}>
        {name}
      </span>
      <span
        title={sub}
        style={{ fontSize: 11.5, color: subColor ?? 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
      >
        {sub}
      </span>
    </span>
  );
}

/**
 * One row's stretch of the time axis. The hatch is a state that began and has not ended
 * (late since, stale since, no sweep since); the inset left of `coveredFrom` is time the
 * read did not reach — twenty runs back ends there, and an empty stretch before it would
 * otherwise read as a schedule that did not fire.
 */
function Axis({ hatch, coveredFrom, children }: { hatch: Hatch | null; coveredFrom: number | null; children?: ReactNode }) {
  return (
    <span style={{ position: 'relative', display: 'block', height: 32 }}>
      {coveredFrom !== null && (
        <span
          title={`Runs before this point are past the last ${RUN_CAP} this read keeps`}
          style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: `${(coveredFrom * 100).toFixed(2)}%`, background: 'var(--surface-inset)', borderRight: '1px dashed var(--border-default)' }}
        />
      )}
      {hatch && (
        <span
          title={hatch.title}
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: `${(hatch.from * 100).toFixed(2)}%`,
            right: 0,
            background:
              'repeating-linear-gradient(135deg, color-mix(in srgb, var(--status-warning-fg) 22%, transparent) 0 4px, transparent 4px 8px)',
          }}
        />
      )}
      {children}
    </span>
  );
}

function Note({ children, tone }: { children: ReactNode; tone?: 'warning' }) {
  return (
    <div
      style={{
        padding: '8px 16px',
        borderTop: '1px solid var(--border-subtle)',
        fontSize: 12,
        color: tone === 'warning' ? 'var(--status-warning-fg)' : 'var(--text-tertiary)',
      }}
    >
      {children}
    </div>
  );
}

function RunTick({ t }: { t: { x: number; failed: boolean; title: string } }) {
  return (
    <span
      role="img"
      aria-label={t.title}
      title={t.title}
      style={{
        position: 'absolute',
        left: `${(t.x * 100).toFixed(3)}%`,
        top: t.failed ? 4 : 9,
        height: t.failed ? 22 : 14,
        width: 2,
        marginLeft: -1,
        background: t.failed ? 'var(--status-danger-fg)' : 'var(--text-tertiary)',
      }}
    />
  );
}
