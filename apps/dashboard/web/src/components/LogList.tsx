import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { Button } from '@substrat-run/ui';
import type { ObservabilityLogEvent } from '../lib/api';
import { ULID, shortId } from '../lib/logs-chips';

/**
 * Log lines as the design's dense stream (#1767): one 28px mono row per line on a fixed
 * grid, a level bar down the left edge, and a click that opens the line's structured
 * fields beneath it — where any value the list can filter by is a link that adds it.
 *
 * Two of the design's columns have no field behind them and are replaced rather than
 * invented: OPERATION is the line's trigger (a stamped request's `METHOD /path`, a
 * scheduled run's name, an RPC's method), and TENANT — there is one tenant on this page,
 * the viewing team — is the invocation's outcome.
 */
export type LogFilter = { level?: string; search?: string; invocationId?: string };

const GRID = '3px 100px 34px 196px 76px minmax(0,1fr) 100px';

const LEVEL: Record<string, { tag: string; color: string; msg: string }> = {
  error: { tag: 'ERR', color: 'var(--status-danger-fg)', msg: 'var(--text-primary)' },
  warn: { tag: 'WRN', color: 'var(--status-warning-fg)', msg: 'var(--text-primary)' },
  info: { tag: 'INF', color: 'var(--text-tertiary)', msg: 'var(--text-secondary)' },
  // `console.log` is its own level on the platform; it reads as info, tagged for what it is.
  log: { tag: 'LOG', color: 'var(--text-tertiary)', msg: 'var(--text-secondary)' },
  debug: { tag: 'DBG', color: 'var(--border-strong)', msg: 'var(--text-tertiary)' },
};
const UNKNOWN_LEVEL = { tag: '—', color: 'var(--border-default)', msg: 'var(--text-secondary)' };

/** The fields the expanded block lists, in the order a reader scans them. */
const FIELDS = [
  'timestamp',
  'level',
  'message',
  'service',
  'outcome',
  'trigger',
  'invocation',
  'entrypoint',
  'requestId',
  'invocationId',
  'cpuTimeMs',
  'wallTimeMs',
] as const satisfies readonly (keyof ObservabilityLogEvent)[];

/** "15:59:08.826" — UTC, like every other clock on these pages. */
export function lineTime(ts: number | null): string {
  return ts === null ? '—' : new Date(ts).toISOString().slice(11, 23);
}

/** The filter a field's value adds, when the list can filter by it. */
function filterFor(key: (typeof FIELDS)[number], e: ObservabilityLogEvent): LogFilter | null {
  if (key === 'level' && e.level && e.level in LEVEL) return { level: e.level };
  if (key === 'message' && e.message && e.message.length <= 200) return { search: e.message };
  if (key === 'invocationId' && e.invocationId && ULID.test(e.invocationId)) return { invocationId: e.invocationId };
  return null;
}

export function LogList({
  events,
  maxHeight = 620,
  onFilter,
}: {
  events: ObservabilityLogEvent[];
  maxHeight?: number;
  onFilter?: (filter: LogFilter) => void;
}) {
  const [open, setOpen] = useState<number | null>(null);
  // A new read is a new list: an index kept across it would open a different line.
  useEffect(() => setOpen(null), [events]);
  const rows = useRef<(HTMLDivElement | null)[]>([]);
  const close = (i: number) => {
    setOpen(null);
    rows.current[i]?.focus();
  };

  return (
    <div role="table" aria-label="Log lines" style={{ maxHeight, overflow: 'auto' }}>
      <div
        role="row"
        style={{ display: 'grid', gridTemplateColumns: GRID, gap: '0 8px', alignItems: 'center', height: 28, paddingRight: 12, fontSize: 10.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-subtle)', position: 'sticky', top: 0, background: 'var(--surface-card)', zIndex: 1 }}
      >
        <span />
        <span role="columnheader" style={{ paddingLeft: 8 }}>Time</span>
        <span role="columnheader">Lvl</span>
        <span role="columnheader">Operation</span>
        <span role="columnheader">Outcome</span>
        <span role="columnheader">Message</span>
        <span role="columnheader" style={{ textAlign: 'right' }}>Invocation</span>
      </div>
      {events.map((e, i) => {
        const lv = (e.level && LEVEL[e.level]) || UNKNOWN_LEVEL;
        const on = open === i;
        const toggle = () => setOpen(on ? null : i);
        const invocation = e.invocationId && ULID.test(e.invocationId) ? e.invocationId : null;
        return (
          <div key={`${e.timestamp}:${e.requestId}:${i}`} role="rowgroup" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
            <div
              ref={(el) => {
                rows.current[i] = el;
              }}
              role="row"
              tabIndex={0}
              aria-expanded={on}
              onClick={toggle}
              onKeyDown={(k: KeyboardEvent) => {
                if (k.target !== k.currentTarget) return;
                if (k.key === 'Enter' || k.key === ' ') {
                  k.preventDefault();
                  toggle();
                } else if (k.key === 'Escape' && on) close(i);
              }}
              className="log-row"
              style={{ display: 'grid', gridTemplateColumns: GRID, gap: '0 8px', alignItems: 'center', height: 28, paddingRight: 12, fontFamily: 'var(--font-mono)', fontSize: 12, cursor: 'pointer', color: 'var(--text-primary)', ...(on ? { background: 'var(--surface-active)' } : {}) }}
            >
              <span aria-hidden style={{ alignSelf: 'stretch', background: lv.color }} />
              <span style={{ paddingLeft: 8, color: 'var(--text-tertiary)' }}>{lineTime(e.timestamp)}</span>
              <span style={{ color: lv.color, fontWeight: 500 }}>{lv.tag}</span>
              <span style={ellipsis} title={e.trigger ?? undefined}>{e.trigger ?? e.entrypoint ?? e.invocation ?? '—'}</span>
              <span style={{ ...ellipsis, color: e.outcome && e.outcome !== 'ok' ? 'var(--status-danger-fg)' : 'var(--text-secondary)' }}>{e.outcome ?? '—'}</span>
              <span style={{ ...ellipsis, color: lv.msg }} title={e.message ?? undefined}>{e.message ?? '—'}</span>
              {invocation && onFilter ? (
                <button
                  type="button"
                  title={`Only invocation ${invocation}`}
                  aria-label={`Only invocation ${invocation}`}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onFilter({ invocationId: invocation });
                  }}
                  style={{ appearance: 'none', border: 0, background: 'none', padding: 0, font: 'inherit', textAlign: 'right', color: 'var(--text-link)', cursor: 'pointer' }}
                >
                  {shortId(invocation)}
                </button>
              ) : (
                <span style={{ textAlign: 'right', color: 'var(--text-tertiary)' }} title={invocation ?? undefined}>
                  {invocation ? shortId(invocation) : '—'}
                </span>
              )}
            </div>
            {on && <LineFields event={e} onFilter={onFilter} onClose={() => close(i)} />}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The line's fields as the JSON they are, inset below the row. Only the fields the read
 * returned are listed — a key with a null value is a key this line did not carry, and
 * `"cpuTimeMs": null` would read as a measurement.
 */
function LineFields({ event, onFilter, onClose }: { event: ObservabilityLogEvent; onFilter: ((f: LogFilter) => void) | undefined; onClose: () => void }) {
  const [raw, setRaw] = useState(false);
  const fields = FIELDS.filter((k) => event[k] !== null && event[k] !== undefined);
  return (
    <section
      aria-label="Log details"
      onKeyDown={(k) => {
        if (k.key === 'Escape') onClose();
      }}
      style={{ padding: '10px 16px 12px 150px', background: 'var(--surface-inset)', borderTop: '1px solid var(--border-subtle)', fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: '20px' }}
    >
      <div style={{ color: 'var(--text-tertiary)' }}>{'{'}</div>
      {fields.map((k) => {
        const v = event[k];
        const shown = k === 'timestamp' ? JSON.stringify(new Date(v as number).toISOString()) : typeof v === 'number' ? String(v) : JSON.stringify(v);
        const filter = onFilter ? filterFor(k, event) : null;
        return (
          <div key={k} style={{ display: 'flex', gap: 6, paddingLeft: 16, minWidth: 0 }}>
            <span style={{ color: 'var(--text-tertiary)', flexShrink: 0 }}>"{k}":</span>
            {filter ? (
              <button
                type="button"
                title={`Filter by ${k}`}
                onClick={() => onFilter!(filter)}
                style={{ appearance: 'none', border: 0, background: 'none', padding: 0, font: 'inherit', textAlign: 'left', overflowWrap: 'anywhere', color: 'var(--text-link)', cursor: 'pointer', textDecoration: 'underline', textDecorationColor: 'var(--border-strong)', textUnderlineOffset: 3 }}
              >
                {shown}
              </button>
            ) : (
              <span style={{ overflowWrap: 'anywhere', color: typeof v === 'number' && k !== 'timestamp' ? 'var(--status-info-fg)' : 'var(--text-primary)' }}>{shown}</span>
            )}
          </div>
        );
      })}
      <div style={{ color: 'var(--text-tertiary)' }}>{'}'}</div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10, fontFamily: 'var(--font-sans)' }}>
        {onFilter && event.invocationId && ULID.test(event.invocationId) && (
          <Button variant="secondary" size="sm" onClick={() => onFilter({ invocationId: event.invocationId! })}>
            Only this invocation’s lines
          </Button>
        )}
        {event.raw !== undefined && (
          <Button variant="ghost" size="sm" onClick={() => setRaw((r) => !r)}>
            {raw ? 'Hide raw event' : 'Raw event'}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
      {raw && (
        <pre style={{ margin: '10px 0 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--text-secondary)' }}>
          {JSON.stringify(event.raw, null, 2)}
        </pre>
      )}
    </section>
  );
}

const ellipsis: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 };
