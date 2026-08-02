import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { api, getSite, type ContentTypeDef, type EntryListItem, type EntryStatus } from './api';
import { Avatar, Button, DragHandle, Modal, Mono, StatusBadge } from './ui';

// The reference-picker vocabulary (design screens 4a/4b/4c). One invariant everywhere:
// the picker shows ENTRIES by stable id — never tables or versions. Draft targets carry
// the ⚠ won't-resolve warning, archived ones the ⛓ broken-link warning.
// 4a modal → refMany (room for reorder + statuses) · 4c inline combobox → single ref.
// 4b (side drawer) hosts the asset library picker for assetRef fields.

export function useTargetEntries(target: string | undefined): EntryListItem[] {
  const [entries, setEntries] = useState<EntryListItem[]>([]);
  useEffect(() => {
    if (target) api.listEntries({ typeKey: target }).then(setEntries).catch(() => setEntries([]));
  }, [target]);
  return entries;
}

/** Minimal valid body for create-and-link: the title gets the query, other required
 *  fields get the cheapest value their Zod schema accepts. The entry lands as a draft. */
function minimalBody(def: ContentTypeDef, title: string): Record<string, unknown> {
  const body: Record<string, unknown> = { [def.titleField]: title };
  for (const [name, f] of Object.entries(def.fields)) {
    if (!f.required || name === def.titleField) continue;
    if (f.type === 'enum') body[name] = f.options?.[0] ?? '';
    else if (f.type === 'bool') body[name] = false;
    else if (f.type === 'int') body[name] = 0;
    else if (f.type === 'textArray' || f.type === 'refMany' || f.type === 'assetRefMany') body[name] = [];
    else body[name] = '';
  }
  return body;
}

const warnLine = (status: EntryStatus): ReactNode =>
  status === 'archived' ? (
    <span style={{ fontSize: 11.5, color: 'var(--st-danger-fg)' }}>⛓ archived — linking it would ship a broken reference</span>
  ) : status !== 'published' ? (
    <span style={{ fontSize: 11.5, color: 'var(--st-review-fg)' }}>⚠ draft — won't resolve at delivery until published</span>
  ) : null;

// ── The chip vocabulary (shared by fields and picker footers) ────────────────

export function RefChip(props: {
  id: string;
  entry?: EntryListItem;
  draggable?: boolean;
  onRemove?: () => void;
  onDragStart?: () => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: () => void;
}) {
  const { entry } = props;
  const archived = entry?.status === 'archived';
  const draft = !!entry && !archived && entry.status !== 'published';
  const style: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '3px 9px',
    borderRadius: 'var(--r-pill)',
    border: `1px solid ${archived ? 'var(--st-danger-fg)' : 'var(--border2)'}`,
    background: archived ? 'var(--st-danger-bg)' : draft ? 'var(--st-review-bg)' : 'var(--wash)',
    fontSize: 12,
    color: archived ? 'var(--st-danger-fg)' : 'var(--ink)',
  };
  return (
    <span
      title={props.id}
      draggable={props.draggable}
      onDragStart={props.onDragStart}
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
      style={style}
    >
      {props.draggable && <DragHandle />}
      {archived && <span title="archived — broken link">⛓</span>}
      {draft && <span title="draft — won't resolve at delivery until published" style={{ color: 'var(--st-review-fg)' }}>⚠</span>}
      <span style={{ textDecoration: archived ? 'line-through' : 'none' }}>
        {entry?.title ?? <Mono>{props.id.slice(0, 8)}…</Mono>}
      </span>
      {props.onRemove && (
        <button onClick={props.onRemove} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 0, font: 'inherit' }}>✕</button>
      )}
    </span>
  );
}

/** An ordered, drag-reorderable chip row for refMany values. */
export function RefChipRow({ ids, byId, onChange }: { ids: string[]; byId: Map<string, EntryListItem>; onChange: (next: string[]) => void }) {
  const dragFrom = useRef<number | null>(null);
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6 }}>
      {ids.map((id, i) => (
        <RefChip
          key={id}
          id={id}
          entry={byId.get(id)}
          draggable={ids.length > 1}
          onRemove={() => onChange(ids.filter((x) => x !== id))}
          onDragStart={() => { dragFrom.current = i; }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => {
            const from = dragFrom.current;
            dragFrom.current = null;
            if (from === null || from === i) return;
            const next = [...ids];
            const [moved] = next.splice(from, 1);
            next.splice(i, 0, moved);
            onChange(next);
          }}
        />
      ))}
    </span>
  );
}

// ── 4a · Modal picker (refMany) ─────────────────────────────────────────────

const searchInput: CSSProperties = {
  font: 'inherit',
  fontSize: 13,
  padding: '7px 11px',
  borderRadius: 'var(--r-input)',
  border: '1px solid var(--border2)',
  background: 'var(--surface)',
  color: 'var(--ink)',
};

export function RefModalPicker(props: {
  fieldName: string;
  ownerTitle: string;
  target: string;
  targetDef?: ContentTypeDef;
  selected: string[];
  onDone: (ids: string[]) => void;
  onClose: () => void;
}) {
  const entries = useTargetEntries(props.target);
  const [sel, setSel] = useState<string[]>(props.selected);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'all' | EntryStatus>('all');
  const [busy, setBusy] = useState(false);
  const [extra, setExtra] = useState<EntryListItem[]>([]); // rows created via create-and-link
  const all = useMemo(() => [...extra, ...entries], [extra, entries]);
  const byId = new Map(all.map((e) => [e.id, e]));

  const shown = all
    .filter((e) => (status === 'all' ? true : e.status === status))
    .filter((e) => (query ? e.title.toLowerCase().includes(query.toLowerCase()) : true));

  const toggle = (id: string) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const targetTitle = props.targetDef?.title ?? props.target;

  const createAndLink = async () => {
    if (!props.targetDef || !query.trim() || busy) return;
    setBusy(true);
    try {
      const created = await api.createEntry(props.target, minimalBody(props.targetDef, query.trim()));
      const row: EntryListItem = { id: created.id, type_key: props.target, status: 'draft', slug: created.slug, title: query.trim(), updated_at: created.updated_at };
      setExtra((x) => [row, ...x]);
      setSel((s) => [...s, created.id]);
      setQuery('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={props.onClose} width={520}>
      <div style={{ padding: '14px 18px 10px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>Link {targetTitle}s</div>
        <Mono style={{ fontSize: 11.5 }}>{props.ownerTitle} › {props.fieldName} · refMany({targetTitle})</Mono>
      </div>
      <div style={{ display: 'flex', gap: 8, padding: '10px 18px' }}>
        <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`⌕  Search ${targetTitle.toLowerCase()}s…`} style={{ ...searchInput, flex: 1 }} />
        <select value={status} onChange={(e) => setStatus(e.target.value as 'all' | EntryStatus)} style={searchInput}>
          <option value="all">All statuses</option>
          {(['draft', 'in_review', 'approved', 'published', 'archived'] as EntryStatus[]).map((s) => (
            <option key={s} value={s}>{s.replace('_', ' ')}</option>
          ))}
        </select>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '0 10px' }}>
        {shown.map((e) => {
          const on = sel.includes(e.id);
          return (
            <div
              key={e.id}
              onClick={() => toggle(e.id)}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 'var(--r-input)', cursor: 'pointer', background: on ? 'var(--accent-soft)' : 'transparent', marginBottom: 2 }}
            >
              <input type="checkbox" readOnly checked={on} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 13.5, textDecoration: e.status === 'archived' ? 'line-through' : 'none', color: e.status === 'archived' ? 'var(--muted)' : 'var(--ink)' }}>{e.title}</span>
                {warnLine(e.status)}
              </span>
              <Mono style={{ fontSize: 11 }}>{e.slug ?? props.target}</Mono>
              <StatusBadge status={e.status} />
            </div>
          );
        })}
        {shown.length === 0 && !query && <div style={{ color: 'var(--muted)', fontSize: 13, padding: '14px 10px' }}>No {targetTitle.toLowerCase()} entries in this site.</div>}
        {query.trim() && props.targetDef && (
          <button
            onClick={() => void createAndLink()}
            disabled={busy}
            style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 10px', margin: '2px 0 8px', font: 'inherit', fontSize: 13, textAlign: 'left', border: '1px dashed var(--border2)', borderRadius: 'var(--r-input)', background: 'transparent', color: 'var(--accent)', cursor: 'pointer' }}
          >
            <span style={{ fontWeight: 600 }}>+</span>
            <span>Create “{query.trim()}” as a new {targetTitle} and link it</span>
          </button>
        )}
      </div>
      <div style={{ borderTop: '1px solid var(--border)', padding: '10px 18px', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <RefChipRow ids={sel} byId={byId} onChange={setSel} />
        <div style={{ flex: 1 }} />
        <Button onClick={props.onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => props.onDone(sel)}>Link {sel.length}</Button>
      </div>
    </Modal>
  );
}

// ── 4c · Inline combobox (single ref) ───────────────────────────────────────

function highlightMatch(title: string, query: string): ReactNode {
  if (!query) return title;
  const at = title.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return title;
  return (
    <>
      {title.slice(0, at)}
      <span style={{ background: 'var(--accent-soft)', color: 'var(--accent)', borderRadius: 3 }}>{title.slice(at, at + query.length)}</span>
      {title.slice(at + query.length)}
    </>
  );
}

export function RefCombobox(props: {
  target: string;
  targetDef?: ContentTypeDef;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const entries = useTargetEntries(props.target);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const targetTitle = props.targetDef?.title ?? props.target;
  const shown = entries.filter((e) => (query ? e.title.toLowerCase().includes(query.toLowerCase()) : true));

  const createAndLink = async () => {
    if (!props.targetDef || !query.trim() || busy) return;
    setBusy(true);
    try {
      const created = await api.createEntry(props.target, minimalBody(props.targetDef, query.trim()));
      props.onPick(created.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 6, border: '1px solid var(--border2)', borderRadius: 'var(--r-input)', background: 'var(--surface)', overflow: 'hidden' }}>
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') props.onClose(); }}
        placeholder={`⌕  Search ${targetTitle.toLowerCase()}s…`}
        style={{ display: 'block', width: '100%', font: 'inherit', fontSize: 13, padding: '8px 12px', border: 'none', borderBottom: '1px solid var(--border)', outline: 'none', background: 'transparent', color: 'var(--ink)' }}
      />
      <div style={{ maxHeight: 240, overflow: 'auto', padding: '4px 6px 6px' }}>
        <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--faint)', padding: '6px 8px 4px' }}>
          {targetTitle}s in {getSite()}
        </div>
        {shown.map((e) => (
          <div
            key={e.id}
            onClick={() => props.onPick(e.id)}
            style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 8px', borderRadius: 'var(--r-input)', cursor: 'pointer' }}
            onMouseEnter={(ev) => { (ev.currentTarget as HTMLElement).style.background = 'var(--wash)'; }}
            onMouseLeave={(ev) => { (ev.currentTarget as HTMLElement).style.background = 'transparent'; }}
          >
            <Avatar name={e.title} size={22} />
            <span style={{ flex: 1, fontSize: 13.5 }}>
              {highlightMatch(e.title, query)}
              {e.status !== 'published' && <span style={{ marginLeft: 8, fontSize: 11.5, color: 'var(--st-review-fg)' }}>⚠ draft</span>}
            </span>
            <StatusBadge status={e.status} />
          </div>
        ))}
        {shown.length === 0 && !query.trim() && <div style={{ color: 'var(--muted)', fontSize: 13, padding: '8px' }}>No {targetTitle.toLowerCase()} entries in this site.</div>}
        {query.trim() && props.targetDef && (
          <button
            onClick={() => void createAndLink()}
            disabled={busy}
            style={{ display: 'block', width: '100%', padding: '8px', font: 'inherit', fontSize: 13, textAlign: 'left', border: 'none', borderTop: '1px solid var(--border)', background: 'transparent', color: 'var(--accent)', cursor: 'pointer' }}
          >
            + Create {targetTitle} “{query.trim()}” and link
          </button>
        )}
      </div>
    </div>
  );
}
