import { useEffect, useState } from 'react';
import { api, ApiError, type LogPattern, type LogPatterns } from '../lib/api';
import { DEV_MOCK } from '../lib/mock';
import { mockLogPatterns } from '../lib/mock-patterns';
import { shareLabel, templateParts } from '../lib/patterns';

/**
 * The Logs › Patterns mode (#1747): the app's `ctx.log` lines grouped by the template each
 * was written with — one row per template, with its dominant level, its count, a small
 * histogram and its share. A row opens its lines in the Lines mode.
 *
 * A pattern is exactly the lines written from one TEMPLATE, because the template was
 * recorded when the line was written rather than guessed afterwards from similar text. It is
 * not a call site: two calls that share a template share a pattern. And a line written with
 * `console.log` has no template and is in no pattern, which the empty state says.
 */

/** How many buckets each row's histogram is cut into. It is drawn 180px wide. */
const BUCKETS = 30;

const LEVEL: Record<LogPattern['dominant'], { tag: string; color: string }> = {
  error: { tag: 'ERR', color: 'var(--status-danger-fg)' },
  warn: { tag: 'WRN', color: 'var(--status-warning-fg)' },
  info: { tag: 'INF', color: 'var(--text-tertiary)' },
  debug: { tag: 'DBG', color: 'var(--border-strong)' },
};

const GRID = '34px minmax(0,1fr) 180px 72px 56px';

export function PatternsMode({
  scopeId,
  window,
  nonce,
  onOpenPattern,
}: {
  scopeId: string;
  /** The window the page shows — sent verbatim, so the histograms are cut on this axis. */
  window: { from: string; to: string };
  nonce: number;
  onOpenPattern: (template: string) => void;
}) {
  const [answer, setAnswer] = useState<LogPatterns | null | { error: string }>(null);

  useEffect(() => {
    let live = true;
    setAnswer(null);
    const span = { from: Date.parse(window.from), to: Date.parse(window.to) };
    if (DEV_MOCK) {
      setAnswer(mockLogPatterns(span, BUCKETS));
      return;
    }
    const q = new URLSearchParams({ since: window.from, until: window.to, buckets: String(BUCKETS) });
    api.appLogPatterns(scopeId, q).then(
      (a) => live && setAnswer(a),
      (e: unknown) =>
        live &&
        setAnswer({
          error:
            e instanceof ApiError && e.status === 501
              ? 'Log patterns are not available on this platform yet.'
              : e instanceof ApiError
                ? `Patterns could not be read (${e.status}): ${e.message}`
                : 'Patterns could not be read right now.',
        }),
    );
    return () => {
      live = false;
    };
  }, [scopeId, window.from, window.to, nonce]);

  const quiet = { padding: 16, fontSize: 13, color: 'var(--text-tertiary)' } as const;
  if (answer === null) return <div style={quiet}>Grouping lines…</div>;
  if ('error' in answer) return <div style={quiet}>{answer.error}</div>;
  if (answer.patterns.length === 0) {
    return (
      <div style={quiet}>
        No lines written with <code>ctx.log</code> in this window. Patterns group lines by the template a{' '}
        <code>ctx.log</code> call was written with; a line from <code>console.log</code> has no template and is not
        in any pattern. Its lines are still in the Lines tab.
      </div>
    );
  }

  const from = Date.parse(window.from);
  const span = Math.max(1, Date.parse(window.to) - from);
  const head = { fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-tertiary)' } as const;
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: 12, padding: '8px 16px', borderBottom: '1px solid var(--border-subtle)', ...head }}>
        <span>Level</span>
        <span>Pattern</span>
        <span>Over time</span>
        <span style={{ textAlign: 'right' }}>Lines</span>
        <span style={{ textAlign: 'right' }}>Share</span>
      </div>
      {answer.patterns.map((p) => {
        const peak = Math.max(1, ...p.buckets.map((b) => b.count));
        const level = LEVEL[p.dominant];
        return (
          <button
            key={p.template}
            type="button"
            data-pattern
            onClick={() => onOpenPattern(p.template)}
            title="Open the lines written from this template"
            style={{ display: 'grid', gridTemplateColumns: GRID, gap: 12, alignItems: 'center', width: '100%', minHeight: 36, padding: '6px 16px', border: 0, borderBottom: '1px solid var(--border-subtle)', background: 'transparent', font: 'inherit', textAlign: 'left', cursor: 'pointer' }}
          >
            <span
              style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600, color: level.color }}
              title={`${p.levels.error} error · ${p.levels.warn} warn · ${p.levels.info} info · ${p.levels.debug} debug`}
            >
              {level.tag}
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.template}>
              {templateParts(p.template).map((part, i) =>
                part.slot ? (
                  <span
                    key={i}
                    data-slot
                    style={{ padding: '0 3px', margin: '0 1px', borderRadius: 3, background: 'var(--surface-brand-subtle)', color: 'var(--text-brand)' }}
                  >
                    {part.text}
                  </span>
                ) : (
                  <span key={i}>{part.text}</span>
                ),
              )}
            </span>
            <span aria-hidden style={{ position: 'relative', height: 22 }}>
              {p.buckets.map((b) => {
                const at = ((Date.parse(b.start) - from) / span) * 100;
                const w = Math.max(0.8, (answer.bucketMs / span) * 100);
                return (
                  <span
                    key={b.start}
                    style={{ position: 'absolute', bottom: 0, left: `${at}%`, width: `calc(${w}% - 1px)`, height: `${Math.max(8, (b.count / peak) * 100)}%`, background: level.color, borderRadius: 1, opacity: 0.85 }}
                  />
                );
              })}
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)', textAlign: 'right' }}>{p.count.toLocaleString('en-US')}</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-tertiary)', textAlign: 'right' }}>{shareLabel(p.share)}</span>
          </button>
        );
      })}
      <div style={{ padding: '10px 16px', fontSize: 12, color: 'var(--text-tertiary)' }}>
        {answer.patterns.length} {answer.patterns.length === 1 ? 'pattern' : 'patterns'} ·{' '}
        <span style={{ fontFamily: 'var(--font-mono)' }}>{answer.total.toLocaleString('en-US')}</span> lines written with ctx.log in this window
        {answer.truncated && ' · the most frequent are shown, more exist'}
        {answer.estimated && ' · counts estimated from a sample'}
      </div>
    </div>
  );
}
