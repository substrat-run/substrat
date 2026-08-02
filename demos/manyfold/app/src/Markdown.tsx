import { useRef, useState, type CSSProperties, type ReactNode } from 'react';

// The richText editor from the design handover: Write/Preview tabs + a B/I/H2/[link]/`code`
// toolbar over a plain textarea, and a small dependency-free markdown renderer for the
// preview (and the read-only entry view). Covers the subset the mock uses: headings,
// bold, italic, inline code, links, lists, code fences, paragraphs.

// ── Renderer ────────────────────────────────────────────────────────────────

function inline(text: string): ReactNode[] {
  // Tokenize `code`, **bold**, *italic*, [label](href) — first match wins, recurse on the rest.
  const out: ReactNode[] = [];
  let rest = text;
  let k = 0;
  const RE = /(`([^`]+)`)|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(\[([^\]]+)\]\(([^)]+)\))/;
  while (rest.length) {
    const m = RE.exec(rest);
    if (!m) { out.push(rest); break; }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    if (m[2] !== undefined) out.push(<code key={k++} style={{ fontFamily: 'var(--mono)', fontSize: '0.92em', background: 'var(--wash)', padding: '1px 5px', borderRadius: 4 }}>{m[2]}</code>);
    else if (m[4] !== undefined) out.push(<strong key={k++}>{m[4]}</strong>);
    else if (m[6] !== undefined) out.push(<em key={k++}>{m[6]}</em>);
    else if (m[8] !== undefined) out.push(<a key={k++} href={m[9]} target="_blank" rel="noreferrer">{m[8]}</a>);
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

export function renderMarkdown(src: string): ReactNode {
  const lines = src.split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++;
      blocks.push(<pre key={k++} style={{ margin: '10px 0', padding: 12, background: 'var(--code-bg)', color: 'var(--code-ink)', fontFamily: 'var(--mono)', fontSize: 12, borderRadius: 'var(--r-input)', overflow: 'auto' }}>{buf.join('\n')}</pre>);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const size = [20, 17, 15, 13.5][level - 1] ?? 13.5;
      blocks.push(<div key={k++} style={{ fontSize: size, fontWeight: 600, margin: '14px 0 6px' }}>{inline(h[2])}</div>);
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ''));
      blocks.push(<ul key={k++} style={{ margin: '6px 0', paddingLeft: 20 }}>{items.map((it, j) => <li key={j} style={{ margin: '2px 0' }}>{inline(it)}</li>)}</ul>);
      continue;
    }
    if (line.trim() === '') { i++; continue; }
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,4})\s|^```|^\s*[-*]\s+/.test(lines[i])) buf.push(lines[i++]);
    blocks.push(<p key={k++} style={{ margin: '6px 0', lineHeight: 1.6 }}>{inline(buf.join(' '))}</p>);
  }
  return <div>{blocks}</div>;
}

// ── Editor ──────────────────────────────────────────────────────────────────

const tabStyle = (active: boolean): CSSProperties => ({
  font: 'inherit',
  fontSize: 12,
  fontWeight: 600,
  padding: '4px 12px',
  border: 'none',
  borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
  background: 'none',
  color: active ? 'var(--ink)' : 'var(--muted)',
  cursor: 'pointer',
});

const toolBtn: CSSProperties = {
  font: 'inherit',
  fontSize: 11.5,
  fontFamily: 'var(--mono)',
  padding: '2px 8px',
  border: '1px solid var(--border2)',
  borderRadius: 5,
  background: 'var(--surface)',
  color: 'var(--muted)',
  cursor: 'pointer',
};

export function MarkdownEditor({ value, onChange, invalid }: { value: string; onChange: (v: string) => void; invalid?: boolean }) {
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const ref = useRef<HTMLTextAreaElement>(null);

  // Wrap the selection (or insert a placeholder) with the given markers.
  const wrap = (before: string, after: string, placeholder: string) => {
    const el = ref.current;
    if (!el) return;
    const [a, b] = [el.selectionStart, el.selectionEnd];
    const sel = value.slice(a, b) || placeholder;
    const next = value.slice(0, a) + before + sel + after + value.slice(b);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(a + before.length, a + before.length + sel.length);
    });
  };
  const prefixLine = (prefix: string, placeholder: string) => {
    const el = ref.current;
    if (!el) return;
    const a = el.selectionStart;
    const lineStart = value.lastIndexOf('\n', a - 1) + 1;
    const empty = value.slice(lineStart).split('\n')[0].trim() === '';
    const next = value.slice(0, lineStart) + prefix + (empty ? placeholder : '') + value.slice(lineStart);
    onChange(next);
  };

  return (
    <div style={{ border: `1px solid ${invalid ? 'var(--st-danger-fg)' : 'var(--border2)'}`, borderRadius: 'var(--r-input)', background: invalid ? 'var(--st-danger-bg)' : 'var(--surface)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '4px 8px 0', borderBottom: '1px solid var(--border)' }}>
        <button type="button" style={tabStyle(tab === 'write')} onClick={() => setTab('write')}>Write</button>
        <button type="button" style={tabStyle(tab === 'preview')} onClick={() => setTab('preview')}>Preview</button>
        <div style={{ flex: 1 }} />
        {tab === 'write' && (
          <span style={{ display: 'inline-flex', gap: 4, paddingBottom: 4 }}>
            <button type="button" title="bold" style={{ ...toolBtn, fontWeight: 700 }} onClick={() => wrap('**', '**', 'bold')}>B</button>
            <button type="button" title="italic" style={{ ...toolBtn, fontStyle: 'italic' }} onClick={() => wrap('*', '*', 'italic')}>I</button>
            <button type="button" title="heading" style={toolBtn} onClick={() => prefixLine('## ', 'Heading')}>H2</button>
            <button type="button" title="link" style={toolBtn} onClick={() => wrap('[', '](https://)', 'link text')}>[link]</button>
            <button type="button" title="inline code" style={toolBtn} onClick={() => wrap('`', '`', 'code')}>`code`</button>
          </span>
        )}
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--faint)', paddingBottom: 4, marginLeft: 6 }}>markdown</span>
      </div>
      {tab === 'write' ? (
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{ display: 'block', width: '100%', minHeight: 140, padding: '10px 12px', font: 'inherit', fontSize: 13.5, lineHeight: 1.6, border: 'none', outline: 'none', resize: 'vertical', background: 'transparent', color: 'var(--ink)' }}
        />
      ) : (
        <div style={{ padding: '10px 14px', minHeight: 140, fontSize: 13.5 }}>
          {value.trim() ? renderMarkdown(value) : <span style={{ color: 'var(--faint)' }}>Nothing to preview yet.</span>}
        </div>
      )}
    </div>
  );
}
