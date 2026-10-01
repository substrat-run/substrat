import { useEffect, useState } from 'react';
import { api, type AppFailuresView } from '../lib/api';
import { exactTime, type ObsQuery } from '../lib/observability-query';
import { card } from '../components/ui';

export function AppFailures({ scopeId, window, nonce, onNav }: {
  scopeId: string;
  window: { since: string; until: string };
  nonce: number;
  onNav: (q: ObsQuery) => void;
}) {
  const [read, setRead] = useState<AppFailuresView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setRead(null);
    setError(null);
    api.appFailures(scopeId, window).then((r) => live && setRead(r))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => { live = false; };
  }, [scopeId, window.since, window.until, nonce]);
  const missing = read?.unavailableSources ?? [];
  const incomplete = read?.incompleteSources ?? [];
  return <div style={{ ...card, padding: 16, display: 'grid', gap: 16 }}>
    <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 13 }}>
      {exactTime(window.since)} – {exactTime(window.until)}.
      {' '}The Failing badge counts errors recorded in the last 24 hours, even when later runs succeed.
    </p>
    {error && <p role="alert">Could not read failures: {error}</p>}
    {!read && !error && <p>Reading failures…</p>}
    {missing.length > 0 && <p role="alert">Could not read {missing.join(', ')}. The failure list is incomplete.</p>}
    {incomplete.length > 0 && <p role="status">Only the newest records are shown for {incomplete.join(', ')}.</p>}
    {read?.entries.length === 0 && missing.length === 0 && incomplete.length === 0 && <p>No failures recorded in this interval.</p>}
    {read?.entries.map((f) => <article key={`${f.kind}:${f.id}`} style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 12 }}>
      <h2 style={{ fontSize: 15, margin: '0 0 8px', overflowWrap: 'anywhere' }}>{f.operation}</h2>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
        {f.kind === 'sweep' ? 'Failed background run' : 'Operation failure'}
        {f.stage ? ` · ${f.stage}` : ''} · {exactTime(f.at)}
      </div>
      {f.code && <p style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{f.code}</p>}
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 13, color: 'var(--status-danger-fg)' }}>{f.message ?? 'No error message was recorded.'}</pre>
      <button type="button" onClick={() => {
        const at = Date.parse(f.at);
        onNav({ app: scopeId, view: 'logs', from: new Date(at - 300_000).toISOString(), to: new Date(Math.min(Date.now(), at + 300_000)).toISOString() });
      }}>Logs around this failure</button>
    </article>)}
  </div>;
}
