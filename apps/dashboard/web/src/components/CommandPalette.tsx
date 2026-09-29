import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Button, openSupport } from '@substrat-run/ui';
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
 * opens, rather than drawing a second one. The design's third mode, **Ask**, is an AI
 * answer with the query it ran (#1749); there is no such answer yet, so there is no mode
 * pretending to give one.
 */

export type PaletteMode = 'jump' | 'support';

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
  onGo,
  onClose,
}: {
  ctx: PaletteContext;
  initialMode?: PaletteMode;
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
        setMode((m) => (m === 'jump' ? 'support' : 'jump'));
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
        aria-label="Jump to, or write to support"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 780, maxWidth: 'calc(100vw - 32px)', background: 'var(--surface-card)', border: '1px solid var(--border-default)', borderRadius: 12, boxShadow: 'var(--shadow-popover)', overflow: 'hidden', display: 'flex', flexDirection: 'column', maxHeight: 'calc(100vh - 128px)' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, height: 52, padding: '0 16px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>
          <Ic name="search" size={16} color="var(--text-tertiary)" />
          <input
            ref={input}
            autoFocus
            // The query belongs to Jump and waits there for Tab back; Support has nothing to type into here.
            value={mode === 'jump' ? q : ''}
            readOnly={mode === 'support'}
            onChange={(e) => setQ(e.target.value)}
            aria-label={mode === 'jump' ? 'Jump to' : 'Support'}
            placeholder={mode === 'jump' ? 'Jump to an app, a process, a page — or paste a request or record id' : 'Write to Substrat support'}
            style={{ flex: 1, minWidth: 0, border: 0, outline: 'none', background: 'transparent', fontSize: 15, color: 'var(--text-primary)', fontFamily: 'var(--font-sans)' }}
          />
          <div role="tablist" aria-label="Mode" style={{ display: 'inline-flex', padding: 2, borderRadius: 8, background: 'var(--surface-inset)', flexShrink: 0 }}>
            {(['jump', 'support'] as const).map((m) => (
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
                {m === 'jump' ? 'Jump' : 'Support'}
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
          <span><Key>↵</Key> {mode === 'jump' ? 'open' : 'write to support'}</span>
          <span><Key>tab</Key> {mode === 'jump' ? 'support' : 'jump'}</span>
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
