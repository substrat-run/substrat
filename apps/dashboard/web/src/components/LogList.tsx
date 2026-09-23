import { useEffect, useRef, useState } from 'react';
import type { ObservabilityLogEvent } from '../lib/api';
import {
  DEFAULT_LOG_COLUMNS,
  LOG_COLUMNS,
  LOG_COLUMN_LABELS,
  LOG_COLUMNS_KEY,
  moveColumn,
  parseLogColumns,
  type LogColumn,
} from '../lib/log-columns';

export function LogList({
  events,
  maxHeight = 420,
  versionOf,
  onFilter,
}: {
  events: ObservabilityLogEvent[];
  maxHeight?: number;
  versionOf?: Record<string, string>;
  onFilter?: (filter: { level?: string; search?: string; invocationId?: string }) => void;
}) {
  const [columns, setColumns] = useState<LogColumn[]>(() => {
    try {
      return parseLogColumns(localStorage.getItem(LOG_COLUMNS_KEY));
    } catch {
      return [...DEFAULT_LOG_COLUMNS];
    }
  });
  const opener = useRef<HTMLButtonElement | null>(null);
  const closeDetails = () => {
    opener.current?.focus();
    setSelected(null);
  };
  const [selected, setSelected] = useState<ObservabilityLogEvent | null>(null);
  useEffect(() => {
    setSelected(null);
  }, [events]);
  useEffect(() => {
    try {
      localStorage.setItem(LOG_COLUMNS_KEY, JSON.stringify(columns));
    } catch {
      /* Private browsing may refuse preferences. */
    }
  }, [columns]);
  const value = (event: ObservabilityLogEvent, column: LogColumn): string => {
    const v = event[column];
    if (v === null || v === undefined) return '—';
    if (column === 'timestamp') return new Date(v as number).toISOString().replace('T', ' ').replace('Z', ' UTC');
    if (column === 'cpuTimeMs' || column === 'wallTimeMs') return `${Number(v).toFixed(1)} ms`;
    return String(v);
  };
  const cellStyle = {
    padding: '8px 12px',
    borderBottom: '1px solid var(--border-subtle)',
    textAlign: 'left' as const,
    verticalAlign: 'top',
    maxWidth: 480,
    overflowWrap: 'anywhere' as const,
  };
  return (
    <div
      className="obs-controls"
      onKeyDown={(e) => {
        if (e.key === 'Escape') closeDetails();
      }}
    >
      <details style={{ padding: '10px 14px', fontSize: 12 }}>
        <summary>Columns · {columns.length} shown</summary>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', padding: '10px 0' }}>
          {LOG_COLUMNS.map((key) => (
            <label key={key}>
              <input
                type="checkbox"
                checked={columns.includes(key)}
                disabled={columns.length === 1 && columns[0] === key}
                onChange={() => setColumns((old) => (old.includes(key) ? old.filter((k) => k !== key) : [...old, key]))}
              />
              {LOG_COLUMN_LABELS[key]}
            </label>
          ))}
        </div>
        <ol>
          {columns.map((key, i) => (
            <li key={key}>
              {LOG_COLUMN_LABELS[key]}{' '}
              <button
                aria-label={`Move ${LOG_COLUMN_LABELS[key]} left`}
                disabled={i === 0}
                onClick={() => setColumns((old) => moveColumn(old, key, -1))}
              >
                ←
              </button>{' '}
              <button
                aria-label={`Move ${LOG_COLUMN_LABELS[key]} right`}
                disabled={i === columns.length - 1}
                onClick={() => setColumns((old) => moveColumn(old, key, 1))}
              >
                →
              </button>
            </li>
          ))}
        </ol>
        <button onClick={() => setColumns([...DEFAULT_LOG_COLUMNS])}>Reset columns</button>
      </details>
      <div style={{ maxHeight, overflow: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
          <thead>
            <tr>
              <th scope="col" style={cellStyle}>
                Details
              </th>
              {columns.map((c) => (
                <th key={c} scope="col" style={{ ...cellStyle, whiteSpace: 'nowrap' }}>
                  {LOG_COLUMN_LABELS[c]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {events.map((event, i) => (
              <tr key={`${event.timestamp}:${event.requestId}:${i}`}>
                <td style={cellStyle}>
                  <button
                    aria-label={`Inspect log ${i + 1}`}
                    aria-expanded={selected === event}
                    onClick={(e) => {
                      opener.current = e.currentTarget;
                      setSelected(selected === event ? null : event);
                    }}
                  >
                    Inspect
                  </button>
                  {versionOf && event.service && <span>{versionOf[event.service] ?? '—'}</span>}
                </td>
                {columns.map((c) => (
                  <td key={c} style={cellStyle}>
                    {value(event, c)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selected && (
        <section aria-label="Log details" style={{ padding: 14, background: 'var(--surface-inset)', fontSize: 12 }}>
          <button onClick={closeDetails}>Close log details</button>
          <dl>
            {LOG_COLUMNS.map((c) => (
              <div key={c} style={{ paddingTop: 6 }}>
                <dt style={{ fontWeight: 600 }}>{LOG_COLUMN_LABELS[c]}</dt>
                <dd style={{ marginLeft: 0, overflowWrap: 'anywhere' }}>
                  {value(selected, c)}{' '}
                  {onFilter &&
                    c === 'level' &&
                    selected.level &&
                    ['log', 'info', 'warn', 'error', 'debug'].includes(selected.level) && (
                      <button onClick={() => onFilter({ level: selected.level! })}>Include this level</button>
                    )}
                  {onFilter && c === 'message' && selected.message && selected.message.length <= 200 && (
                    <button onClick={() => onFilter({ search: selected.message! })}>Filter message contains</button>
                  )}
                  {onFilter &&
                    c === 'invocationId' &&
                    selected.invocationId &&
                    /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(selected.invocationId) && (
                      <button onClick={() => onFilter({ invocationId: selected.invocationId! })}>
                        Show this invocation
                      </button>
                    )}
                </dd>
              </div>
            ))}
          </dl>
          <details>
            <summary>Raw event</summary>
            <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {JSON.stringify(selected.raw, null, 2) ?? 'No raw event supplied'}
            </pre>
          </details>
        </section>
      )}
    </div>
  );
}
