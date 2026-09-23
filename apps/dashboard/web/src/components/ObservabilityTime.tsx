import { useEffect, useState } from 'react';
import { Button, Input } from '@substrat-run/ui';
import { exactTime } from '../lib/observability-query';
export function ObservabilityTime({
  window,
  onApply,
  onReset,
  onUndo,
  canUndo,
}: {
  window: { since: string; until: string };
  onApply: (w: { from: string; to: string }) => void;
  onReset: () => void;
  onUndo: () => void;
  canUndo: boolean;
}) {
  const [from, setFrom] = useState(window.since),
    [to, setTo] = useState(window.until);
  useEffect(() => {
    setFrom(window.since);
    setTo(window.until);
  }, [window.since, window.until]);
  return (
    <div className="obs-controls" style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
      <details style={{ flex: 1 }}>
        <summary style={{ cursor: 'pointer', fontSize: 12 }}>
          {exactTime(window.since)} – {exactTime(window.until)} · Edit time
        </summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onApply({ from, to });
          }}
          style={{ display: 'flex', gap: 8, flexWrap: 'wrap', paddingTop: 10 }}
        >
          <Input label="Start (ISO with timezone)" value={from} onChange={(e) => setFrom(e.target.value)} />
          <Input label="End (exclusive)" value={to} onChange={(e) => setTo(e.target.value)} />
          <Button>Apply time</Button>
        </form>
      </details>
      <button type="button" onClick={onUndo} disabled={!canUndo}>
        Undo zoom
      </button>
      <button type="button" onClick={onReset}>
        Reset time
      </button>
    </div>
  );
}
