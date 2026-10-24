import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Badge, Button, openSupport } from '@substrat-run/ui';
import { foldTurn, historyFor, type AskTurn } from '../lib/ask';
import { writtenAtLabel } from '../lib/explanations';
import { Ic, type IconName } from '../lib/icons';
import { useEscapeLayer } from '../lib/escape-stack';
import { paletteItems, type PaletteContext, type PaletteGo, type PaletteGroup, type PaletteItem } from '../lib/palette';

/**
 * The ⌘K overlay (#1921, design "⌘K overlay"): one place to jump anywhere and to reach
 * support. Opened by ⌘K / Ctrl+K or the top-bar field; Esc closes, Tab switches mode, the
 * arrows move and Enter opens.
 *
 * **Jump** lists apps, their process maps, the dashboard's pages and a few actions, the
 * reader's app first; a pasted id opens that request or that record in the app the reader
 * is in. What is offered is `paletteItems` (pure, tested) — this file draws and runs it.
 *
 * **Support** sends the reader to the support desk's own conversation, the one the bubble
 * opens, rather than drawing a second one.
 *
 * **Ask** (#2283, #1749) is a question to the dashboard's assistant, answered from what it read
 * through the dashboard's own reads: each answer carries the AI marker, the reads it made and
 * when it was written. It is offered only where the deployment writes AI text (`ask` is null
 * otherwise), and the conversation lasts as long as the overlay is open: nothing records a
 * thread yet.
 */

export type PaletteMode = 'jump' | 'ask' | 'support';

/** What the overlay calls to ask: the dashboard's `dashboard/ask` route, or the preview's stand-in. */
export type AskFn = (input: { messages: Array<{ role: 'user' | 'assistant'; text: string }> }) => Promise<{ events: Array<Record<string, unknown>> }>;

const mono: CSSProperties = { fontFamily: 'var(--font-mono)' };

const ICON: Record<PaletteGroup, IconName> = {
  'Open by id': 'search',
  Apps: 'grid',
  'Process maps': 'chart',
  Pages: 'layers',
  Actions: 'plus',
};

export function CommandPalette({
  ctx,
  initialMode = 'jump',
  ask = null,
  onGo,
  onClose,
}: {
  ctx: PaletteContext;
  initialMode?: PaletteMode;
  /** The assistant, where this deployment offers it; null draws no Ask mode. */
  ask?: AskFn | null;
  onGo: (go: PaletteGo) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<PaletteMode>(initialMode);
  const [q, setQ] = useState('');
  const items = useMemo(() => paletteItems(q, ctx), [q, ctx]);
  const [sel, setSel] = useState(0);
  useEffect(() => setSel(0), [q, mode]);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [support, setSupport] = useState<'idle' | 'bubble' | 'none'>('idle');
  const modes: PaletteMode[] = ask ? ['jump', 'ask', 'support'] : ['jump', 'support'];
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<AskTurn[]>([]);
  const [asking, setAsking] = useState(false);
  const send = () => {
    const text = question.trim();
    if (!ask || !text || asking) return;
    setAsking(true);
    setQuestion('');
    ask({ messages: historyFor(turns, text) })
      .then(({ events }) => setTurns((t) => [...t, foldTurn(events)]))
      .catch((e: unknown) =>
        setTurns((t) => [...t, { question: text, looks: [], answer: '', provenance: null, budgetExhausted: false, error: e instanceof Error ? e.message : String(e) }]),
      )
      .finally(() => setAsking(false));
  };

  const run = (item: PaletteItem | undefined) => {
    if (!item) return;
    onGo(item.go);
    onClose();
  };
  const writeToSupport = () => {
    if (openSupport()) {
      onClose();
      return;
    }
    // An older widget.js offers no `open`; no widget at all means no desk on this deployment.
    setSupport(typeof window !== 'undefined' && window.ticket0 ? 'bubble' : 'none');
  };

  // Above any open panel, so Escape closes the overlay and leaves the panel open.
  useEscapeLayer(onClose);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        setMode((m) => modes[(modes.indexOf(m) + 1) % modes.length]!);
        input.current?.focus();
      } else if (mode === 'jump' && e.key === 'ArrowDown') {
        e.preventDefault();
        setSel((s) => Math.min(s + 1, items.length - 1));
      } else if (mode === 'jump' && e.key === 'ArrowUp') {
        e.preventDefault();
        setSel((s) => Math.max(s - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (mode === 'jump') run(items[sel]);
        else if (mode === 'ask') send();
        else writeToSupport();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Keep the selected row in view as the arrows move through a long list.
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${sel}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [sel]);

  const groups: { group: PaletteGroup; items: { item: PaletteItem; index: number }[] }[] = [];
  items.forEach((item, index) => {
    const last = groups.at(-1);
    if (last?.group === item.group) last.items.push({ item, index });
    else groups.push({ group: item.group, items: [{ item, index }] });
  });

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'color-mix(in srgb, var(--gray-950) 55%, transparent)', zIndex: 200, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 64 }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={ask ? 'Jump to, ask, or write to support' : 'Jump to, or write to support'}
        onClick={(e) => e.stopPropagation()}
        style={{ width: 780, maxWidth: 'calc(100vw - 32px)', background: 'var(--surface-card)', border: '1px solid var(--border-default)', borderRadius: 12, boxShadow: 'var(--shadow-popover)', overflow: 'hidden', display: 'flex', flexDirection: 'column', maxHeight: 'calc(100vh - 128px)' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, height: 52, padding: '0 16px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>
          <Ic name="search" size={16} color="var(--text-tertiary)" />
          <input
            ref={input}
            autoFocus
            // The query belongs to Jump and waits there for Tab back; Support has nothing to type into here.
            value={mode === 'jump' ? q : mode === 'ask' ? question : ''}
            readOnly={mode === 'support'}
            onChange={(e) => (mode === 'ask' ? setQuestion(e.target.value) : setQ(e.target.value))}
            aria-label={mode === 'jump' ? 'Jump to' : mode === 'ask' ? 'Ask' : 'Support'}
            maxLength={mode === 'ask' ? 4000 : undefined}
            placeholder={
              mode === 'jump'
                ? 'Jump to an app, a process, a page — or paste a request or record id'
                : mode === 'ask'
                  ? 'Ask about your apps — “why is the deploy failing?”'
                  : 'Write to Substrat support'
            }
            style={{ flex: 1, minWidth: 0, border: 0, outline: 'none', background: 'transparent', fontSize: 15, color: 'var(--text-primary)', fontFamily: 'var(--font-sans)' }}
          />
          <div role="tablist" aria-label="Mode" style={{ display: 'inline-flex', padding: 2, borderRadius: 8, background: 'var(--surface-inset)', flexShrink: 0 }}>
            {modes.map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                onClick={() => {
                  setMode(m);
                  input.current?.focus();
                }}
                style={{
                  appearance: 'none',
                  border: 0,
                  borderRadius: 6,
                  padding: '4px 10px',
                  font: 'inherit',
                  fontSize: 12.5,
                  cursor: 'pointer',
                  background: mode === m ? 'var(--surface-card)' : 'transparent',
                  color: mode === m ? 'var(--text-primary)' : 'var(--text-tertiary)',
                  boxShadow: mode === m ? 'var(--shadow-sm)' : 'none',
                }}
              >
                {m === 'jump' ? 'Jump' : m === 'ask' ? 'Ask' : 'Support'}
              </button>
            ))}
          </div>
          <Key>esc</Key>
        </div>

        <div ref={list} style={{ overflowY: 'auto', padding: '6px 0', minHeight: 120 }}>
          {mode === 'jump' ? (
            items.length === 0 ? (
              <Quiet>Nothing matches “{q}”. An id opens a request or a record once you are in an app.</Quiet>
            ) : (
              groups.map((g) => (
                <div key={g.group} role="group" aria-label={g.group}>
                  <div style={{ padding: '8px 20px 4px', fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>{g.group}</div>
                  {g.items.map(({ item, index }) => (
                    <div
                      key={item.key}
                      data-index={index}
                      role="option"
                      aria-selected={index === sel}
                      onMouseEnter={() => setSel(index)}
                      onClick={() => run(item)}
                      style={{ display: 'flex', alignItems: 'center', gap: 10, height: 38, padding: '0 12px', margin: '0 8px', borderRadius: 6, fontSize: 13, cursor: 'pointer', background: index === sel ? 'var(--surface-active)' : 'transparent' }}
                    >
                      <Ic name={ICON[item.group]} size={14} color="var(--text-tertiary)" />
                      <span style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', ...(item.group === 'Open by id' ? mono : {}) }}>{item.label}</span>
                      {item.detail && <span style={{ ...mono, fontSize: 11.5, color: 'var(--text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.detail}</span>}
                      <div style={{ flex: 1 }} />
                      {index === sel && <Key>↵</Key>}
                    </div>
                  ))}
                </div>
              ))
            )
          ) : mode === 'ask' ? (
            <AskThread turns={turns} asking={asking} />
          ) : (
            <div style={{ padding: '14px 20px', display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
              <div style={{ fontSize: 13.5, fontWeight: 600 }}>Substrat support</div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', maxWidth: 620 }}>
                A person on the Substrat team reads every conversation. They see what you write and who you are signed in as — not
                the data in your apps.
              </div>
              <Button onClick={writeToSupport}>Write to Substrat support</Button>
              {support === 'bubble' && <Quiet inline>The support chat is the bubble at the bottom right of the page.</Quiet>}
              {support === 'none' && <Quiet inline>Support is not set up on this deployment.</Quiet>}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 14, height: 40, padding: '0 16px', borderTop: '1px solid var(--border-subtle)', background: 'var(--surface-inset)', fontSize: 11.5, color: 'var(--text-tertiary)', flexShrink: 0 }}>
          {mode === 'jump' && <span><Key>↑↓</Key> move</span>}
          <span><Key>↵</Key> {mode === 'jump' ? 'open' : mode === 'ask' ? 'ask' : 'write to support'}</span>
          <span><Key>tab</Key> {modes[(modes.indexOf(mode) + 1) % modes.length]}</span>
          <span><Key>esc</Key> close</span>
        </div>
      </div>
    </div>
  );
}

/**
 * The conversation so far: each question, the reads the assistant made, and its answer under the
 * AI marker with when it was written and from how many reads. Rendered as text, so markup a
 * model wrote is never markup.
 */
function AskThread({ turns, asking }: { turns: readonly AskTurn[]; asking: boolean }) {
  if (turns.length === 0 && !asking) {
    return (
      <Quiet>
        Ask about your apps, their findings and failures. The assistant reads what you can read here, and only reads: it changes
        nothing. The conversation ends when you close this.
      </Quiet>
    );
  }
  return (
    <div style={{ padding: '10px 20px', display: 'flex', flexDirection: 'column', gap: 14 }} aria-live="polite">
      {turns.map((t, i) => (
        <div key={i} data-ask-turn={i} style={{ display: 'grid', gap: 6 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{t.question}</div>
          {t.looks.length > 0 && <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{t.looks.map((l) => l.label).join(' · ')}</div>}
          {t.answer && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <Badge status="brand" dot={false} style={{ flexShrink: 0 }}>
                AI
              </Badge>
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--text-primary)' }}>{t.answer}</p>
            </div>
          )}
          {t.provenance && (
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
              Answered {writtenAtLabel(t.provenance.producedAt)} from {t.provenance.sources} {t.provenance.sources === 1 ? 'read' : 'reads'}
              {t.provenance.model && <> · model {t.provenance.model.split('/').pop()}</>}
            </div>
          )}
          {t.error && (
            <div role="alert" style={{ fontSize: 12.5, color: 'var(--status-danger-fg)' }}>
              {t.error}
            </div>
          )}
          {!t.error && t.budgetExhausted && <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>That was today’s last AI answer.</div>}
        </div>
      ))}
      {asking && <Quiet inline>Reading…</Quiet>}
    </div>
  );
}

function Quiet({ children, inline }: { children: ReactNode; inline?: boolean }) {
  return <div style={{ padding: inline ? 0 : '14px 20px', fontSize: 12.5, color: 'var(--text-tertiary)' }}>{children}</div>;
}

function Key({ children }: { children: string }) {
  return <span style={{ ...mono, fontSize: 10.5, border: '1px solid var(--border-default)', borderRadius: 4, padding: '0 4px', color: 'var(--text-tertiary)', flexShrink: 0 }}>{children}</span>;
}
