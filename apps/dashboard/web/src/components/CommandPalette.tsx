import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AssistantModel } from '@substrat-run/elements/assistant-model';
import { openSupport } from '@substrat-run/ui';
import { Assistant, Button, Input, Segmented, type FieldHandle } from '@substrat-run/ui/wa';
import { ASK_LABELS, askSource, type AskFn } from '../lib/ask';
import { Ic, type IconName } from '../lib/icons';
import { useEscapeLayer } from '../lib/escape-stack';
import { paletteItems, type PaletteContext, type PaletteGo, type PaletteGroup, type PaletteItem } from '../lib/palette';

/**
 * The ⌘K overlay (#1921, design "⌘K overlay"): one place to jump anywhere and to reach
 * support. Opened by ⌘K / Ctrl+K or the top-bar field; Esc closes, Tab switches mode until
 * Ask has a conversation to move through, the arrows move and Enter opens.
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
 * when it was written. `<sub-assistant>` draws it, and the overlay's own field is its input. It
 * is offered only where the deployment writes AI text (`ask` is null otherwise), and the
 * conversation lasts as long as the overlay is open: nothing records a thread yet.
 */

export type PaletteMode = 'jump' | 'ask' | 'support';

export type { AskFn };

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
  const input = useRef<FieldHandle>(null);
  const list = useRef<HTMLDivElement>(null);
  const [support, setSupport] = useState<'idle' | 'bubble' | 'none'>('idle');
  const modes: PaletteMode[] = ask ? ['jump', 'ask', 'support'] : ['jump', 'support'];
  const [question, setQuestion] = useState('');
  const conversation = useMemo(() => (ask ? new AssistantModel({ source: askSource(ask) }) : null), [ask]);
  const [asked, setAsked] = useState(false);
  useEffect(() => conversation?.subscribe((s) => setAsked(s.turns.length > 0)), [conversation]);
  const send = () => {
    if (conversation?.send(question)) setQuestion('');
  };
  // Once there is a conversation Tab moves through it, since Retry and a source are controls too.
  const tabSwitches = !(mode === 'ask' && asked);

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
      // A control inside the answer has already taken this Enter.
      if (e.defaultPrevented) return;
      if (e.key === 'Tab') {
        if (!tabSwitches) return;
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
          <Input
            ref={input}
            bare
            autoFocus
            // The query belongs to Jump and waits there for Tab back; Support has nothing to type into here.
            value={mode === 'jump' ? q : mode === 'ask' ? question : ''}
            readOnly={mode === 'support'}
            onChange={(e) => (mode === 'ask' ? setQuestion(e.target.value) : setQ(e.target.value))}
            ariaLabel={mode === 'jump' ? 'Jump to' : mode === 'ask' ? 'Ask' : 'Support'}
            maxLength={mode === 'ask' ? 4000 : undefined}
            placeholder={
              mode === 'jump'
                ? 'Jump to an app, a process, a page — or paste a request or record id'
                : mode === 'ask'
                  ? 'Ask about your apps — “why is the deploy failing?”'
                  : 'Write to Substrat support'
            }
            style={{ flex: 1, minWidth: 0, fontSize: 15 }}
          />
          <div onClick={() => input.current?.focus()} style={{ flexShrink: 0 }}>
            <Segmented
              label="Mode"
              options={modes.map((m) => ({ value: m, label: m === 'jump' ? 'Jump' : m === 'ask' ? 'Ask' : 'Support' }))}
              value={mode}
              onChange={setMode}
            />
          </div>
          <Key>esc</Key>
        </div>

        <div
          ref={list}
          style={mode === 'ask' ? { display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 120 } : { overflowY: 'auto', padding: '6px 0', minHeight: 120 }}
        >
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
          ) : mode === 'ask' && conversation ? (
            <Assistant
              model={conversation}
              labels={ASK_LABELS}
              hideComposer
              style={{ minHeight: 0 }}
              empty={
                <span style={{ fontSize: 12.5 }}>
                  Ask about your apps, their findings and failures. The assistant reads what you can read here, and only reads: it changes
                  nothing. The conversation ends when you close this.
                </span>
              }
            />
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
          {tabSwitches && <span><Key>tab</Key> {modes[(modes.indexOf(mode) + 1) % modes.length]}</span>}
          <span><Key>esc</Key> close</span>
        </div>
      </div>
    </div>
  );
}

function Quiet({ children, inline }: { children: ReactNode; inline?: boolean }) {
  return <div style={{ padding: inline ? 0 : '14px 20px', fontSize: 12.5, color: 'var(--text-tertiary)' }}>{children}</div>;
}

function Key({ children }: { children: string }) {
  return <span style={{ ...mono, fontSize: 10.5, border: '1px solid var(--border-default)', borderRadius: 4, padding: '0 4px', color: 'var(--text-tertiary)', flexShrink: 0 }}>{children}</span>;
}
