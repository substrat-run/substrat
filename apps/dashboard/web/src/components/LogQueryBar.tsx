import { useState, type ReactNode } from 'react';
import type { ObsQuery } from '../lib/observability-query';
import type { LogMode } from '../lib/log-stream';
import { logChips, parseBarText, windowLabel, without, type LogChip } from '../lib/logs-chips';

/**
 * The Logs query bar (#1767): one 36px field holding the filters as removable chips, then
 * a free-text input that adds one more. Every chip is a URL key read back, so removing a
 * chip, clearing them all and pressing Enter are each one navigation — the same query a
 * pasted link would carry.
 */
export function LogQueryBar({
  query,
  mode,
  cursor,
  onQuery,
  children,
}: {
  query: ObsQuery;
  mode: LogMode;
  /** The page's custom window, drawn as a chip of its own — removing it returns to the range. */
  cursor: { from: string; to: string } | null;
  /** The whole next query — never a patch, so a removed key is really gone. */
  onQuery: (q: ObsQuery) => void;
  /** The controls to the right of the field: the app filter and the range. */
  children?: ReactNode;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const chips: LogChip[] = [
    ...logChips(query, mode),
    ...(cursor ? [{ key: 'time', value: windowLabel(cursor.from, cursor.to), clears: ['from', 'to'] as (keyof ObsQuery)[] }] : []),
  ];
  const submit = () => {
    const parsed = parseBarText(text, mode);
    if (!parsed) return;
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }
    setError('');
    setText('');
    onQuery({ ...query, ...parsed.add });
  };
  const placeholder =
    mode === 'events'
      ? chips.length
        ? 'Event type…'
        : 'Filter by event type, or click a bucket to narrow down'
      : chips.length
        ? 'Filter messages…'
        : 'Filter messages (case-sensitive), level:error, or click any value to narrow down';

  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div
          role="search"
          aria-label="Log filters"
          style={{ flex: 1, minWidth: 320, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, minHeight: 36, padding: '4px 10px', boxSizing: 'border-box', border: '1px solid var(--border-default)', borderRadius: 6, background: 'var(--surface-card)', boxShadow: 'var(--shadow-xs)' }}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          {chips.map((c) => (
            <span
              key={c.key}
              data-chip={c.key}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, height: 24, maxWidth: 360, padding: '0 4px 0 8px', borderRadius: 999, background: 'var(--surface-brand-subtle)', border: '1px solid var(--border-brand)', fontSize: 12 }}
            >
              <span style={{ color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>{c.key}</span>
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.value}>
                {c.value}
              </span>
              <button
                type="button"
                title="Remove filter"
                aria-label={`Remove ${c.key} filter`}
                onClick={() => onQuery(without(query, c.clears))}
                style={{ width: 16, height: 16, border: 0, background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer', padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
              >
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </svg>
              </button>
            </span>
          ))}
          <input
            aria-label={mode === 'events' ? 'Filter event type' : 'Search messages'}
            value={text}
            placeholder={placeholder}
            onChange={(e) => {
              setText(e.target.value);
              if (error) setError('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              } else if (e.key === 'Backspace' && text === '' && chips.length > 0) {
                // The chip nearest the cursor goes first, as in any token field.
                onQuery(without(query, chips[chips.length - 1]!.clears));
              }
            }}
            style={{ flex: 1, minWidth: 180, height: 26, border: 0, outline: 'none', background: 'transparent', color: 'var(--text-primary)', font: 'inherit', fontSize: 13 }}
          />
          {chips.length > 0 && (
            <button
              type="button"
              onClick={() => onQuery(without(query, chips.flatMap((c) => c.clears)))}
              style={{ appearance: 'none', border: 0, background: 'none', padding: 0, font: 'inherit', fontSize: 12, color: 'var(--text-link)', cursor: 'pointer' }}
            >
              Clear
            </button>
          )}
        </div>
        {children}
      </div>
      {error && (
        <span role="alert" style={{ fontSize: 12, color: 'var(--status-danger-fg)' }}>
          {error}
        </span>
      )}
    </div>
  );
}
