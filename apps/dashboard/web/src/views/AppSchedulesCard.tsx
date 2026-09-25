import { useState, type CSSProperties, type ReactNode } from 'react';
import { Badge } from '@substrat-run/ui';
import type { SchedulesState } from '../lib/use-app-schedules';
import { card } from '../components/ui';
import { navigate, obsPath, teamPath } from '../lib/router';
import type { ObsQuery } from '../lib/observability-query';
import {
  FRESHNESS_VERDICT,
  RUN_CAP,
  SCHEDULE_VERDICT,
  cadenceLabel,
  clock,
  freshnessSentence,
  lastRunCell,
  stripSlots,
} from '../lib/schedule-rows';

/**
 * App › Overview's "Schedules and freshness" card (#1767): each declared schedule with its
 * recent runs as a fixed strip, and each freshness rule as the sentence it produces. The
 * glance; Pulse's Schedules view draws the same runs at their real times, one click away.
 * Absent when the running version declares neither — most verticals — and while the read is
 * in flight or has failed (the read is the Overview's, shared with the Health tile), so the Overview never grows a card that says nothing.
 */
export function AppSchedulesCard({ scopeId, schedules: read }: { scopeId: string; schedules: SchedulesState }) {
  const view = read.state === 'ok' ? read.view : null;
  const schedules = view?.schedules ?? [];
  const freshness = view?.freshness ?? [];
  if (!view || (schedules.length === 0 && freshness.length === 0)) return null;
  const now = Date.now();
  const to = (q: ObsQuery) => obsPath({ app: scopeId, ...q });

  return (
    <div style={{ ...card, boxShadow: 'var(--shadow-sm)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px' }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>Schedules and freshness</span>
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>declared in the model · last {RUN_CAP} runs</span>
        <span style={{ flex: 1 }} />
        <a
          href={teamPath(to({ view: 'schedules' }))}
          onClick={(e) => {
            e.preventDefault();
            navigate(to({ view: 'schedules' }));
          }}
          style={{ fontSize: 12.5, color: 'var(--text-brand)' }}
        >
          Open schedules →
        </a>
      </div>
      {schedules.map((row) => {
        const last = lastRunCell(row, now);
        const v = SCHEDULE_VERDICT[row.health];
        return (
          <RowLink key={`${row.moduleId}:${row.operation}`} path={to({ view: 'schedules' })} columns={SCHEDULE_COLUMNS} minHeight={44}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.operation}>
              {row.operation}
            </span>
            <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{cadenceLabel(row.everyMinutes)}</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: last.failed ? 'var(--status-danger-fg)' : 'var(--text-secondary)' }}>
              {last.text}
            </span>
            <span style={{ display: 'flex', gap: 2, alignItems: 'center' }} aria-label={`Last ${RUN_CAP} runs, oldest first`}>
              {stripSlots(row.runs).map((r, i) => (
                <span
                  key={r?.id ?? `empty:${i}`}
                  role="img"
                  aria-label={r ? `${r.outcome}${r.error ? `: ${r.error}` : ''} · ${clock(r.at)}` : 'no run'}
                  title={r ? `${r.outcome}${r.error ? `: ${r.error}` : ''} · ${clock(r.at)}` : 'no run'}
                  style={slot(r?.outcome ?? null)}
                />
              ))}
            </span>
            <span style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Badge status={v.status}>{v.label}</Badge>
            </span>
          </RowLink>
        );
      })}
      {freshness.length > 0 && (
        <>
          <div
            style={{
              padding: '8px 16px',
              borderTop: '1px solid var(--border-default)',
              background: 'var(--surface-inset)',
              fontSize: 11,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: 'var(--text-tertiary)',
            }}
          >
            Freshness rules
          </div>
          {freshness.map((row) => {
            const v = FRESHNESS_VERDICT[row.health];
            const mark = MARK[row.health];
            return (
              <RowLink key={`fresh:${row.eventType}`} path={to({ view: 'events', type: row.eventType })} columns="22px minmax(0,1fr) 200px 120px" minHeight={40}>
                <span aria-hidden style={{ fontSize: 13, color: mark.color, textAlign: 'center' }}>{mark.glyph}</span>
                <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>{freshnessSentence(row, now)}</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-tertiary)' }}>expect ≤ {row.withinHours}h</span>
                <span style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <Badge status={v.status}>{v.label}</Badge>
                </span>
              </RowLink>
            );
          })}
        </>
      )}
    </div>
  );
}

/**
 * The prototype's columns are 120 / 150 / 250 / 120px, drawn for a full-width card; on the
 * Overview the card shares the row with the Activity column, and those widths left the
 * schedule's own name about a hundred pixels. The strip column is exactly twenty slots wide.
 */
const SCHEDULE_COLUMNS = 'minmax(0,1fr) 100px 130px 200px 110px';

/** The rule's leading glyph — a shape as well as a colour, so the verdict is never colour alone. */
const MARK: Record<keyof typeof FRESHNESS_VERDICT, { glyph: string; color: string }> = {
  fresh: { glyph: '✓', color: 'var(--status-success-fg)' },
  stale: { glyph: '●', color: 'var(--status-danger-fg)' },
  'never-seen': { glyph: '○', color: 'var(--text-tertiary)' },
  'sweeper-silent': { glyph: '▲', color: 'var(--status-warning-fg)' },
};

/** One strip slot: grey for a run, red for a failure, a dashed outline where no run is recorded. */
function slot(outcome: 'ok' | 'failed' | 'skipped' | null): CSSProperties {
  const base: CSSProperties = { width: 8, height: 14, borderRadius: 2, boxSizing: 'border-box', display: 'inline-block', flexShrink: 0 };
  if (outcome === 'ok') return { ...base, background: 'var(--text-tertiary)' };
  if (outcome === 'failed') return { ...base, background: 'var(--status-danger-fg)' };
  if (outcome === 'skipped') return { ...base, border: '1px solid var(--border-strong)' };
  return { ...base, border: '1px dashed var(--border-default)' };
}

function RowLink({ path, columns, minHeight, children }: { path: string; columns: string; minHeight: number; children: ReactNode }) {
  const [hover, setHover] = useState(false);
  return (
    <a
      href={teamPath(path)}
      onClick={(e) => {
        e.preventDefault();
        navigate(path);
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'grid',
        gridTemplateColumns: columns,
        gap: '0 12px',
        alignItems: 'center',
        minHeight,
        padding: '4px 16px',
        borderTop: '1px solid var(--border-subtle)',
        color: 'var(--text-primary)',
        textDecoration: 'none',
        cursor: 'pointer',
        background: hover ? 'var(--surface-hover)' : undefined,
      }}
    >
      {children}
    </a>
  );
}
