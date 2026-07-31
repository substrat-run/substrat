import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError, type ContentTypeDef, type FieldDef } from './api';
import { Button, Card, Mono } from './ui';

// Group B — the model builder. Content types are DATA (save-type/list-types), so an admin
// can create and edit them here and the content editor picks them up immediately. Every
// edit compiles (client-side, live) to the CREATE TABLE it would stage for review — the
// schema-as-diff differentiator, never a live ALTER.

const FIELD_TYPES = ['text', 'richText', 'slug', 'bool', 'int', 'date', 'enum', 'textArray', 'assetRef', 'assetRefMany', 'ref', 'refMany'] as const;
type FieldType = (typeof FIELD_TYPES)[number];

const TYPE_CHIP: Record<string, string> = {
  text: 'TEXT', richText: 'TEXT', slug: 'TEXT', date: 'TEXT', enum: 'TEXT + CHECK',
  bool: 'INTEGER 0/1', int: 'INTEGER', assetRef: 'ULID', assetRefMany: 'child table',
  ref: 'ULID → entry', refMany: 'join table', textArray: 'child table',
};
const SQL_COLUMN: Partial<Record<FieldType, string>> = {
  text: 'TEXT', richText: 'TEXT', slug: 'TEXT', date: 'TEXT', enum: 'TEXT', assetRef: 'TEXT', ref: 'TEXT', bool: 'INTEGER', int: 'INTEGER',
};

// Client mirror of the server's compileTypeToSql — the live preview as you edit.
function compileTypeToSql(def: ContentTypeDef): string {
  const cols = ['  entry_id TEXT NOT NULL', '  rev_no INTEGER NOT NULL'];
  const children: string[] = [];
  for (const [name, f] of Object.entries(def.fields)) {
    const col = SQL_COLUMN[f.type as FieldType];
    if (col) cols.push(`  ${name} ${col}${f.required ? ' NOT NULL' : ''}`);
    else children.push(`CREATE TABLE ct_${def.key}_${name} (entry_id TEXT NOT NULL, rev_no INTEGER NOT NULL, position INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY (entry_id, rev_no, position));`);
  }
  cols.push('  PRIMARY KEY (entry_id, rev_no)');
  const table = `CREATE TABLE ct_${def.key}_v${def.version} (\n${cols.join(',\n')}\n);`;
  const idx = Object.entries(def.fields).filter(([, f]) => f.index).map(([n]) => `CREATE INDEX ct_${def.key}_${n} ON ct_${def.key}_v${def.version} (${n});`);
  return [table, ...idx, ...children].join('\n');
}

function ProductTitle({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--accent)', marginBottom: 4 }}>Tenant-wide · builder</div>
      <h1 style={{ fontSize: 26, fontWeight: 600, margin: 0 }}>{children}</h1>
      {sub && <div style={{ color: 'var(--muted)', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function useTypes(): { types: { def: ContentTypeDef; sql: string }[]; reload: () => void } {
  const [types, setTypes] = useState<{ def: ContentTypeDef; sql: string }[]>([]);
  const reload = () => api.listTypes().then(setTypes).catch(() => setTypes([]));
  useEffect(() => { reload(); }, []);
  return { types, reload };
}

export function ModelsView({ canAdmin, onOpen, onNew }: { canAdmin: boolean; onOpen: (key: string) => void; onNew: () => void }) {
  const { types } = useTypes();
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <ProductTitle sub="Content types are data — create and edit them here; the editor picks them up immediately.">Models</ProductTitle>
        <Button variant="primary" disabled={!canAdmin} title={canAdmin ? '' : 'Disabled: needs the admin permission in this site.'} onClick={onNew}>New model</Button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 14 }}>
        {types.map(({ def }) => (
          <Card key={def.key} style={{ cursor: 'pointer' }}>
            <div onClick={() => onOpen(def.key)}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 16, fontWeight: 600 }}>{def.title}</span>
                <Mono style={{ fontSize: 11.5 }}>v{def.version}</Mono>
              </div>
              <Mono style={{ display: 'block', marginTop: 6 }}>ct_{def.key}_v{def.version} · {Object.keys(def.fields).length} fields</Mono>
              <div style={{ marginTop: 12, fontSize: 12, color: 'var(--faint)', lineHeight: 1.6 }}>
                {Object.entries(def.fields).map(([n, f], i) => (
                  <span key={n}>
                    {i > 0 && ' · '}
                    {n}
                    {(f.type === 'ref' || f.type === 'refMany') && f.target ? <span style={{ color: 'var(--accent)' }}> →{f.target}</span> : null}
                  </span>
                ))}
              </div>
            </div>
          </Card>
        ))}
      </div>
      <div style={{ marginTop: 16, padding: '12px 16px', border: '1px dashed var(--border2)', borderRadius: 'var(--r-card)', fontSize: 12.5, color: 'var(--muted)' }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--faint)', marginRight: 8 }}>NOTE</span>
        Editing a model never touches live tables. Changes compile to a reviewed migration; the schema is
        tenant-wide and each site scope applies it lazily on next open.
      </div>
    </div>
  );
}

// ── The editable model editor ────────────────────────────────────────────────

interface Draft { key: string; title: string; titleField: string; slugField: string; fields: [string, FieldDef][] }

const blankDraft = (): Draft => ({ key: '', title: '', titleField: '', slugField: '', fields: [['title', { type: 'text', required: true }]] });

function toDraft(def: ContentTypeDef): Draft {
  return { key: def.key, title: def.title, titleField: def.titleField, slugField: def.slugField ?? '', fields: Object.entries(def.fields) };
}

export function ModelEditorView(props: { typeKey: string | null; canAdmin: boolean; onSaved: () => void; onCancel: () => void }) {
  const { types } = useTypes();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (props.typeKey === null) { setDraft(blankDraft()); return; }
    const found = types.find((t) => t.def.key === props.typeKey);
    if (found) setDraft(toDraft(found.def));
  }, [props.typeKey, types]);

  const otherTypes = types.map((t) => t.def.key).filter((k) => k !== draft?.key);
  const version = types.find((t) => t.def.key === draft?.key)?.def.version ?? 0;

  const previewDef: ContentTypeDef | null = useMemo(() => {
    if (!draft) return null;
    return {
      key: draft.key || 'new_type',
      version: (version || 0) + 1,
      title: draft.title || 'New type',
      titleField: draft.titleField,
      ...(draft.slugField ? { slugField: draft.slugField } : {}),
      fields: Object.fromEntries(draft.fields),
    };
  }, [draft, version]);

  if (!draft || !previewDef) return <div style={{ color: 'var(--muted)' }}>Loading…</div>;
  const isNew = props.typeKey === null;
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const setField = (i: number, name: string, f: FieldDef) => set({ fields: draft.fields.map((row, j) => (j === i ? [name, f] : row)) });
  const addField = () => set({ fields: [...draft.fields, [`field${draft.fields.length + 1}`, { type: 'text' }]] });
  const removeField = (i: number) => set({ fields: draft.fields.filter((_, j) => j !== i) });

  const save = async () => {
    setErr(''); setBusy(true);
    try {
      await api.saveType({
        key: draft.key,
        title: draft.title,
        titleField: draft.titleField,
        ...(draft.slugField ? { slugField: draft.slugField } : {}),
        fields: Object.fromEntries(draft.fields),
      });
      props.onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const fieldNames = draft.fields.map(([n]) => n);
  return (
    <div>
      <button onClick={props.onCancel} style={{ font: 'inherit', fontSize: 12.5, color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginBottom: 10 }}>← models</button>
      <ProductTitle sub={<Mono>{isNew ? 'new model' : `ct_${draft.key}_v${version} → v${version + 1} on save`}</Mono>}>{isNew ? 'New model' : draft.title}</ProductTitle>

      {err && <div style={{ padding: '10px 14px', borderRadius: 'var(--r-input)', background: 'var(--st-danger-bg)', color: 'var(--st-danger-fg)', fontSize: 13, marginBottom: 14 }}>{err}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 16 }}>
        <Card>
          <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
            <Labeled label="key">
              <input disabled={!isNew} value={draft.key} onChange={(e) => set({ key: e.target.value })} placeholder="recipe" style={{ ...inp, fontFamily: 'var(--mono)', opacity: isNew ? 1 : 0.6 }} />
            </Labeled>
            <Labeled label="title"><input value={draft.title} onChange={(e) => set({ title: e.target.value })} placeholder="Recipe" style={inp} /></Labeled>
          </div>

          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--faint)', marginBottom: 8 }}>Fields</div>
          {draft.fields.map(([name, f], i) => (
            <FieldRow
              key={i}
              name={name}
              f={f}
              targets={otherTypes}
              isTitle={name === draft.titleField}
              isSlug={name === draft.slugField}
              onName={(n) => setField(i, n, f)}
              onField={(nf) => setField(i, name, nf)}
              onMakeTitle={() => set({ titleField: name })}
              onMakeSlug={() => set({ slugField: draft.slugField === name ? '' : name })}
              onRemove={() => removeField(i)}
            />
          ))}
          <div style={{ marginTop: 10 }}><Button size="sm" onClick={addField}>+ add field</Button></div>

          <div style={{ display: 'flex', gap: 8, marginTop: 18, alignItems: 'center' }}>
            <Button variant="primary" disabled={!props.canAdmin || busy || !draft.key || !fieldNames.includes(draft.titleField)} title={props.canAdmin ? '' : 'Disabled: needs the admin permission in this site.'} onClick={save}>
              {busy ? 'Saving…' : isNew ? 'Create model' : 'Save & bump version'}
            </Button>
            <Button onClick={props.onCancel}>Cancel</Button>
            {!fieldNames.includes(draft.titleField) && <span style={{ fontSize: 12, color: 'var(--st-danger-fg)' }}>pick a title field (★)</span>}
          </div>
        </Card>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>What happens on save</div>
            {[
              <>DSL compiles your edits to <Mono style={{ fontSize: 11 }}>CREATE TABLE ct_{previewDef.key}_v{previewDef.version}</Mono> + a backfill step.</>,
              <>The migration waits for review — nothing is live yet.</>,
              <>Once admitted, each site scope applies it lazily on next open.</>,
            ].map((step, i) => (
              <div key={i} style={{ display: 'flex', gap: 10, marginBottom: 8, fontSize: 12.5, color: 'var(--muted)' }}>
                <span style={{ flex: '0 0 18px', height: 18, borderRadius: 'var(--r-pill)', background: 'var(--accent-soft)', color: 'var(--accent)', fontSize: 11, fontWeight: 600, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{i + 1}</span>
                <span style={{ lineHeight: 1.5 }}>{step}</span>
              </div>
            ))}
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)', fontSize: 11.5, color: 'var(--faint)', lineHeight: 1.5 }}>
              Retyping or removing a field is append-only too — the new version simply doesn't carry the column; old revisions stay readable in the prior table.
            </div>
          </Card>
          <Card>
            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--faint)', marginBottom: 8 }}>Compiles to · migration preview</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>Save stages this migration for review — never a live ALTER.</div>
            <pre style={{ margin: 0, padding: 12, background: 'var(--code-bg)', color: 'var(--code-ink)', fontFamily: 'var(--mono)', fontSize: 11, borderRadius: 'var(--r-input)', overflow: 'auto', maxHeight: 420 }}>
              {compileTypeToSql(previewDef).split('\n').map((l, i) => (
                <div key={i} style={{ background: 'var(--diff-add-bg)', color: 'var(--diff-add-fg)', padding: '0 4px' }}>+ {l}</div>
              ))}
            </pre>
          </Card>
        </div>
      </div>
    </div>
  );
}

const inp: React.CSSProperties = { font: 'inherit', fontSize: 13, padding: '6px 9px', borderRadius: 'var(--r-input)', border: '1px solid var(--border2)', background: 'var(--surface)', color: 'var(--ink)' };

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, fontWeight: 600, color: 'var(--muted)' }}>
      {label}
      {children}
    </label>
  );
}

function FieldRow(props: {
  name: string; f: FieldDef; targets: string[]; isTitle: boolean; isSlug: boolean;
  onName: (n: string) => void; onField: (f: FieldDef) => void; onMakeTitle: () => void; onMakeSlug: () => void; onRemove: () => void;
}) {
  const { f } = props;
  const isRef = f.type === 'ref' || f.type === 'refMany';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
      <input value={props.name} onChange={(e) => props.onName(e.target.value)} style={{ ...inp, width: 120, fontFamily: 'var(--mono)' }} />
      <select value={f.type} onChange={(e) => props.onField({ ...f, type: e.target.value as FieldDef['type'], target: undefined })} style={{ ...inp, width: 110 }}>
        {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      {isRef && (
        <select value={f.target ?? ''} onChange={(e) => props.onField({ ...f, target: e.target.value || undefined })} style={{ ...inp, width: 100 }}>
          <option value="">target…</option>
          {props.targets.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      )}
      {f.type === 'enum' && (
        <input placeholder="a | b | c" value={(f.options ?? []).join(' | ')} onChange={(e) => props.onField({ ...f, options: e.target.value.split('|').map((s) => s.trim()).filter(Boolean) })} style={{ ...inp, width: 120 }} />
      )}
      <label style={{ fontSize: 11.5, color: 'var(--muted)', display: 'inline-flex', gap: 3, alignItems: 'center' }}>
        <input type="checkbox" checked={!!f.required} onChange={(e) => props.onField({ ...f, required: e.target.checked })} /> req
      </label>
      <button title="title field" onClick={props.onMakeTitle} style={starBtn(props.isTitle)}>★</button>
      <button title="slug field" onClick={props.onMakeSlug} style={starBtn(props.isSlug)}>⚑</button>
      <Mono style={{ fontSize: 10.5, flex: 1, textAlign: 'right' }}>{TYPE_CHIP[f.type]}</Mono>
      <button onClick={props.onRemove} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)' }}>✕</button>
    </div>
  );
}

const starBtn = (on: boolean): React.CSSProperties => ({ border: 'none', background: 'none', cursor: 'pointer', fontSize: 13, color: on ? 'var(--accent)' : 'var(--faint)' });

// ── Migrations + Relationship map (unchanged, now over the live model) ────────

export function MigrationsView() {
  const { types } = useTypes();
  return (
    <div>
      <ProductTitle sub="Every content-model change compiles to a reviewed migration — never a live ALTER.">Migrations</ProductTitle>
      {types.map(({ def, sql }) => (
        <Card key={def.key} style={{ padding: 0, overflow: 'hidden', marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
            <Mono style={{ color: 'var(--ink)' }}>{String(def.version).padStart(4, '0')}-{def.key}-v{def.version}</Mono>
            <span style={{ fontSize: 11.5, fontWeight: 600, padding: '2px 9px', borderRadius: 'var(--r-pill)', background: 'var(--st-published-bg)', color: 'var(--st-published-fg)' }}>ADMITTED</span>
            <div style={{ flex: 1 }} />
            <Mono style={{ fontSize: 11 }}>applies lazily per scope</Mono>
          </div>
          <pre style={{ margin: 0, padding: 12, background: 'var(--code-bg)', color: 'var(--code-ink)', fontFamily: 'var(--mono)', fontSize: 11, overflow: 'auto' }}>
            {sql.split('\n').map((l, i) => <div key={i} style={{ background: 'var(--diff-add-bg)', color: 'var(--diff-add-fg)', padding: '0 4px' }}>+ {l}</div>)}
          </pre>
        </Card>
      ))}
    </div>
  );
}

export function RelationshipMap() {
  const { types } = useTypes();
  const defs = types.map((t) => t.def);
  const cols = 2;
  const pos = new Map<string, { x: number; y: number }>();
  defs.forEach((d, i) => pos.set(d.key, { x: 80 + (i % cols) * 300, y: 70 + Math.floor(i / cols) * 150 }));
  const assets = { x: 80 + (defs.length % cols) * 300, y: 70 + Math.floor(defs.length / cols) * 150 };
  const edges: { from: string; to: { x: number; y: number }; label: string; kind: 'ref' | 'refMany' | 'asset' }[] = [];
  for (const d of defs) {
    for (const [name, f] of Object.entries(d.fields)) {
      if ((f.type === 'ref' || f.type === 'refMany') && f.target && pos.get(f.target)) edges.push({ from: d.key, to: pos.get(f.target)!, label: `${f.type} · ${name}`, kind: f.type });
      else if (f.type === 'assetRef' || f.type === 'assetRefMany') edges.push({ from: d.key, to: assets, label: `assetRef · ${name}`, kind: 'asset' });
    }
  }
  const W = 700, H = 90 + Math.ceil((defs.length + 1) / cols) * 150;
  const NODE_W = 150, NODE_H = 58;
  const center = (p: { x: number; y: number }) => ({ x: p.x + NODE_W / 2, y: p.y + NODE_H / 2 });
  return (
    <div>
      <ProductTitle sub="Content types and the references that connect them — updates live as you model.">Relationships</ProductTitle>
      <Card style={{ padding: 0, overflow: 'auto' }}>
        <svg width={W} height={H} style={{ display: 'block', minWidth: W }}>
          {edges.map((e, i) => {
            const a = center(pos.get(e.from)!); const b = center(e.to);
            const stroke = e.kind === 'asset' ? 'var(--faint)' : 'var(--accent)';
            return (
              <g key={i}>
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={stroke} strokeWidth={e.kind === 'refMany' ? 2.5 : 1.3} strokeDasharray={e.kind === 'asset' ? '4 4' : undefined} />
                <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 4} fontSize={9.5} fontFamily="var(--mono)" fill="var(--muted)" textAnchor="middle">{e.label}</text>
              </g>
            );
          })}
          {defs.map((d) => {
            const p = pos.get(d.key)!;
            return (
              <g key={d.key}>
                <rect x={p.x} y={p.y} width={NODE_W} height={NODE_H} rx={10} fill="var(--surface)" stroke="var(--accent)" strokeWidth={1.5} />
                <text x={p.x + 12} y={p.y + 24} fontSize={14} fontWeight={600} fill="var(--ink)">{d.title}</text>
                <text x={p.x + 12} y={p.y + 42} fontSize={10.5} fontFamily="var(--mono)" fill="var(--muted)">{Object.keys(d.fields).length} fields · v{d.version}</text>
              </g>
            );
          })}
          <g>
            <rect x={assets.x} y={assets.y} width={NODE_W} height={NODE_H} rx={10} fill="var(--wash)" stroke="var(--border2)" strokeWidth={1.5} strokeDasharray="5 4" />
            <text x={assets.x + 12} y={assets.y + 34} fontSize={13} fontWeight={600} fill="var(--muted)">Assets</text>
          </g>
        </svg>
      </Card>
    </div>
  );
}
