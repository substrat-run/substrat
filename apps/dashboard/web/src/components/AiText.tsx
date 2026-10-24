import { useCallback, useEffect, useState } from 'react';
import { Badge, Button } from '@substrat-run/ui';
import type { ExplanationView } from '../lib/api.generated';
import { aiState, provenanceLine, sourceLabel, spentNote } from '../lib/explanations';
import { isPlainClick, navigate, teamPath } from '../lib/router';

/**
 * One block of AI-written text (#1749): the visible `AI` marker, the paragraph as plain text,
 * and under it the provenance line and its sources, each a link to where it is checked.
 *
 * Nothing is fetched until the block is open, and nothing is written until the reader asks:
 * reading costs a few plane reads, writing costs a model call the platform pays for. The text
 * is rendered as text (React escapes it), so a paragraph carries no markup, link or image a
 * model could have been talked into producing.
 */
export function AiText({
  load,
  write,
  writeLabel,
}: {
  load: () => Promise<ExplanationView>;
  write: () => Promise<ExplanationView>;
  /** The button's words before anything is written: "Explain this finding". */
  writeLabel: string;
}) {
  const [view, setView] = useState<ExplanationView | null>(null);
  const [failed, setFailed] = useState('');
  const [writing, setWriting] = useState(false);

  useEffect(() => {
    let live = true;
    load()
      .then((v) => live && setView(v))
      .catch((e: unknown) => live && setFailed(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [load]);

  const run = useCallback(() => {
    setWriting(true);
    setFailed('');
    write()
      .then(setView)
      .catch((e: unknown) => setFailed(e instanceof Error ? e.message : String(e)))
      .finally(() => setWriting(false));
  }, [write]);

  if (!view) return failed ? <Line tone="danger">{failed}</Line> : <Line>Reading…</Line>;
  const state = aiState(view);
  if (state.kind === 'hidden') return <Line>AI explanations are not offered on this deployment.</Line>;

  const disclosure = view.disclosure && (
    <Line>
      Runs on {view.disclosure.vendor} ({view.disclosure.location}). Sent: {view.disclosure.sent.toLowerCase()}.
    </Line>
  );

  if (state.kind === 'offer') {
    return (
      <div style={{ display: 'grid', gap: 6 }}>
        <div>
          <Button variant="secondary" size="sm" loading={writing} disabled={state.spent} onClick={run}>
            {writeLabel}
          </Button>
        </div>
        {state.spent ? <Line>{spentNote(view)}</Line> : disclosure}
        {failed && <Line tone="danger">{failed}</Line>}
      </div>
    );
  }

  const p = view.explanation!.provenance;
  return (
    <div style={{ display: 'grid', gap: 6, borderLeft: '2px solid var(--border-subtle)', paddingLeft: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <Badge status="brand" dot={false} style={{ flexShrink: 0 }}>
          AI
        </Badge>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--text-primary)' }}>{state.text}</p>
      </div>
      <Line>
        {provenanceLine(p)} ·{' '}
        {p.sources.map((s, i) => (
          <span key={`${s.kind}-${i}`}>
            {i > 0 && ', '}
            {s.href ? (
              <a
                href={teamPath(s.href)}
                onClick={(e) => {
                  if (!isPlainClick(e)) return;
                  e.preventDefault();
                  navigate(s.href!);
                }}
              >
                {sourceLabel(s.kind)}
              </a>
            ) : (
              sourceLabel(s.kind)
            )}
          </span>
        ))}
        {' '}· <span title={p.model}>model {p.model.split('/').pop()}</span>
      </Line>
      {!state.current && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Line>Written against older data: the evidence has moved since.</Line>
          <Button variant="ghost" size="sm" loading={writing} disabled={state.spent} onClick={run}>
            Rewrite
          </Button>
        </div>
      )}
      {state.spent && !state.current && <Line>{spentNote(view)}</Line>}
      {failed && <Line tone="danger">{failed}</Line>}
    </div>
  );
}

function Line({ children, tone }: { children: React.ReactNode; tone?: 'danger' }) {
  return (
    <div role={tone === 'danger' ? 'alert' : undefined} style={{ fontSize: 12, color: tone === 'danger' ? 'var(--status-danger-fg)' : 'var(--text-tertiary)' }}>
      {children}
    </div>
  );
}

/**
 * Whether this deployment writes AI text at all: one read for a whole page, so a toggle is only
 * drawn where pressing it can lead somewhere. `null` while the answer is out; a failed read is
 * treated as "not offered", since the block would fail the same way.
 */
export function useAiOffered(status: () => Promise<ExplanationView>): boolean | null {
  const [offered, setOffered] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(status)
      .then((v) => live && setOffered(v.available))
      .catch(() => live && setOffered(false));
    return () => {
      live = false;
    };
  }, [status]);
  return offered;
}
