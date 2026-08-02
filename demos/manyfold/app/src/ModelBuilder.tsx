import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { api, ApiError, getSite, type ContentTypeDef, type EntryListItem, type FieldDef, type Site } from './api';
import { Button, Card, DragHandle, MicroLabel, Modal, Mono, TypeChip } from './ui';

// Group B — the model builder (design screens 7–11). Content types are DATA
// (save-type/list-types), so an admin edits them here and the content editor picks
// them up immediately. The posture throughout is schema-as-diff: edits STAGE changes
// (tinted rows, never a live write), "Review migration →" shows the generated SQL as
// an add-diff (11a), and "Propose for admission" is the actual save. The migrations
// view then reads plan-first (11b) with per-scope lazy apply.

const FIELD_TYPES = ['text', 'richText', 'slug', 'bool', 'int', 'date', 'enum', 'textArray', 'assetRef', 'assetRefMany', 'ref', 'refMany'] as const;
type FieldType = (typeof FIELD_TYPES)[number];

const TYPE_CHIP: Record<string, string> = {
  text: 'TEXT', richText: 'TEXT', slug: 'TEXT', date: 'TEXT+idx', enum: 'TEXT + CHECK',
  bool: 'INT 0/1', int: 'INTEGER', assetRef: 'ULID', assetRefMany: 'join table',
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

/** The backfill INSERT for vN←vN-1: shared scalar columns copy over, new ones start NULL. */
function backfillSql(next: ContentTypeDef, prev: ContentTypeDef | null): string | null {
  if (!prev || next.version <= 1) return null;
  const cols = Object.entries(next.fields)
    .filter(([, f]) => SQL_COLUMN[f.type as FieldType])
    .map(([name]) => (prev.fields[name] && SQL_COLUMN[prev.fields[name].type as FieldType] ? name : 'NULL'));
  return `INSERT INTO ct_${next.key}_v${next.version}\n  SELECT entry_id, rev_no, ${cols.join(', ')}\n  FROM ct_${next.key}_v${prev.version};`;
}

const migrationId = (key: string, version: number): string => `${String(version).padStart(4, '0')}-${key}-v${version}`;

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

// ── The staged model editor (screen 8) ──────────────────────────────────────

interface Draft { key: string; title: string; titleField: string; slugField: string; fields: [string, FieldDef][] }

const blankDraft = (): Draft => ({ key: '', title: '', titleField: 'title', slugField: '', fields: [['title', { type: 'text', required: true }]] });

function toDraft(def: ContentTypeDef): Draft {
  return { key: def.key, title: def.title, titleField: def.titleField, slugField: def.slugField ?? '', fields: Object.entries(def.fields) };
}

function draftToDef(draft: Draft, version: number): ContentTypeDef {
  return {
    key: draft.key || 'new_type',
    version,
    title: draft.title || 'New type',
    titleField: draft.titleField,
    ...(draft.slugField ? { slugField: draft.slugField } : {}),
    fields: Object.fromEntries(draft.fields),
  };
}

type RowStatus = { kind: 'unchanged' } | { kind: 'new' } | { kind: 'modified'; what: string };

/** The staged-diff status of a field row vs the live baseline. */
function rowStatus(name: string, f: FieldDef, baseline: ContentTypeDef | null): RowStatus {
  const prev = baseline?.fields[name];
  if (!prev) return baseline ? { kind: 'new' } : { kind: 'unchanged' }; // a brand-new model isn't a diff
  const what: string[] = [];
  if (prev.type !== f.type) what.push(`type: ${f.type} (was ${prev.type})`);
  if ((prev.required ?? false) !== (f.required ?? false)) what.push(f.required ? 'required (was optional)' : 'optional (was required)');
  if ((prev.index ?? false) !== (f.index ?? false)) what.push(`index: ${f.index ? 'true' : 'false'} (was ${prev.index ? 'true' : 'false'})`);
  if ((prev.target ?? '') !== (f.target ?? '')) what.push(`target: ${f.target ?? '—'} (was ${prev.target ?? '—'})`);
  if ((prev.maxLen ?? 0) !== (f.maxLen ?? 0)) what.push(`max: ${f.maxLen ?? '—'} (was ${prev.maxLen ?? '—'})`);
  if ((prev.options ?? []).join('|') !== (f.options ?? []).join('|')) what.push(`options: ${(f.options ?? []).join(' | ')}`);
  if ((prev.source ?? '') !== (f.source ?? '')) what.push(`from: ${f.source ?? '—'}`);
  return what.length ? { kind: 'modified', what: what.join(' · ') } : { kind: 'unchanged' };
}

/** The muted config summary on a field row ("required · by stable entry id"). */
function configSummary(name: string, f: FieldDef, draft: Draft): string {
  const bits: string[] = [];
  if (f.required) bits.push('required');
  if (f.type === 'ref') bits.push('by stable entry id');
  if (f.type === 'refMany') bits.push('join table');
  if (f.type === 'slug') bits.push(f.source ? `from ${f.source} · unique per site` : 'unique per site');
  if (f.type === 'enum') bits.push((f.options ?? []).join(' | '));
  if (f.maxLen) bits.push(`max ${f.maxLen}`);
  if (f.index) bits.push('indexed');
  if (name === draft.titleField) bits.push('★ title field');
  if (name === draft.slugField) bits.push('⚑ slug field');
  return bits.join(' · ');
}

export function ModelEditorView(props: { typeKey: string | null; canAdmin: boolean; onSaved: () => void; onCancel: () => void }) {
  const { types } = useTypes();
  const [baseline, setBaseline] = useState<ContentTypeDef | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editing, setEditing] = useState<number | 'add' | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const dragFrom = useRef<number | null>(null);

  useEffect(() => {
    if (props.typeKey === null) { setBaseline(null); setDraft(blankDraft()); return; }
    const found = types.find((t) => t.def.key === props.typeKey);
    if (found) { setBaseline(found.def); setDraft(toDraft(found.def)); }
  }, [props.typeKey, types]);

  const isNew = props.typeKey === null;
  const version = baseline?.version ?? 0;
  const nextVersion = version + 1;
  const nextDef = useMemo(() => (draft ? draftToDef(draft, nextVersion) : null), [draft, nextVersion]);

  if (!draft || !nextDef) return <div style={{ color: 'var(--muted)' }}>Loading…</div>;
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });

  const statuses = draft.fields.map(([n, f]) => rowStatus(n, f, baseline));
  const removed = baseline ? Object.keys(baseline.fields).filter((n) => !draft.fields.some(([dn]) => dn === n)) : [];
  // Meta edits (title, ★/⚑ markers, field order) stage a new version too — without this,
  // a marker-only change would never enable "Review migration".
  const metaChanged = !!baseline && (
    draft.title !== baseline.title ||
    draft.titleField !== baseline.titleField ||
    draft.slugField !== (baseline.slugField ?? '') ||
    draft.fields.map(([n]) => n).join(',') !== Object.keys(baseline.fields).join(',')
  );
  const stagedCount = isNew
    ? draft.fields.length
    : statuses.filter((s) => s.kind !== 'unchanged').length + removed.length + (metaChanged ? 1 : 0);
  const dirty = isNew || stagedCount > 0;

  const fieldNames = draft.fields.map(([n]) => n);
  const valid = !!draft.key && !!draft.title && fieldNames.includes(draft.titleField);
  const reason = !props.canAdmin
    ? 'Disabled: needs the admin permission in this site.'
    : !valid
      ? 'Pick a key, a title and a ★ title field first.'
      : !dirty
        ? 'No staged changes yet.'
        : '';

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
      setReviewing(false);
    } finally {
      setBusy(false);
    }
  };

  if (reviewing) {
    return (
      <MigrationReview
        nextDef={nextDef}
        baseline={baseline}
        stagedCount={stagedCount}
        busy={busy}
        err={err}
        onBack={() => setReviewing(false)}
        onDiscard={() => { setReviewing(false); setDraft(baseline ? toDraft(baseline) : blankDraft()); }}
        onAdmit={() => void save()}
      />
    );
  }

  return (
    <div>
      <button onClick={props.onCancel} style={{ font: 'inherit', fontSize: 12.5, color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginBottom: 10 }}>← models</button>
      <ProductTitle sub={<Mono>{isNew ? 'new model' : `key: ${draft.key} · live v${version} · editing v${nextVersion} (staged)`}</Mono>}>{isNew ? 'New model' : draft.title}</ProductTitle>

      {err && <div style={{ padding: '10px 14px', borderRadius: 'var(--r-input)', background: 'var(--st-danger-bg)', color: 'var(--st-danger-fg)', fontSize: 13, marginBottom: 14 }}>{err}</div>}

      {dirty && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', marginBottom: 16, borderRadius: 'var(--r-input)', background: 'var(--st-review-bg)', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.05em', color: 'var(--st-review-fg)' }}>
            {isNew ? `NEW MODEL · ${draft.fields.length} FIELDS` : `${stagedCount} STAGED CHANGE${stagedCount === 1 ? '' : 'S'}`}
          </span>
          <span style={{ fontSize: 12.5, color: 'var(--st-review-fg)' }}>
            compile to <Mono style={{ fontSize: 11.5, color: 'inherit' }}>{migrationId(nextDef.key, nextVersion)}</Mono> — create <Mono style={{ fontSize: 11.5, color: 'inherit' }}>ct_{nextDef.key}_v{nextVersion}</Mono>{version > 0 ? ' + backfill from v' + version : ''}
          </span>
          <div style={{ flex: 1 }} />
          {!isNew && <Button size="sm" onClick={() => setDraft(baseline ? toDraft(baseline) : blankDraft())}>Discard</Button>}
          <Button size="sm" variant="primary" disabled={!!reason} title={reason} onClick={() => setReviewing(true)}>Review migration →</Button>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16, alignItems: 'start' }}>
        <Card>
          <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
            <Labeled label="key">
              <input disabled={!isNew} value={draft.key} onChange={(e) => set({ key: e.target.value })} placeholder="recipe" style={{ ...inp, fontFamily: 'var(--mono)', opacity: isNew ? 1 : 0.6 }} />
            </Labeled>
            <Labeled label="title"><input value={draft.title} onChange={(e) => set({ title: e.target.value })} placeholder="Recipe" style={inp} /></Labeled>
          </div>

          <MicroLabel>Fields</MicroLabel>
          {draft.fields.map(([name, f], i) => {
            const st = isNew ? ({ kind: 'unchanged' } as RowStatus) : statuses[i];
            const bg = st.kind === 'new' ? 'var(--diff-add-bg)' : st.kind === 'modified' ? 'var(--st-review-bg)' : 'transparent';
            return (
              <div
                key={`${name}-${i}`}
                draggable
                onDragStart={() => { dragFrom.current = i; }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  const from = dragFrom.current;
                  dragFrom.current = null;
                  if (from === null || from === i) return;
                  const next = [...draft.fields];
                  const [moved] = next.splice(from, 1);
                  next.splice(i, 0, moved);
                  set({ fields: next });
                }}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', margin: '0 -10px', borderBottom: '1px solid var(--border)', background: bg, borderRadius: 6 }}
              >
                <DragHandle />
                <Mono style={{ fontSize: 12.5, color: 'var(--ink)', width: 110, overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</Mono>
                <TypeChip>{f.type === 'ref' || f.type === 'refMany' ? `${f.type}(${f.target ?? '?'})` : f.type}</TypeChip>
                <span style={{ flex: 1, fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {st.kind === 'new' ? (
                    <span style={{ color: 'var(--diff-add-fg)', fontWeight: 600 }}>NEW{configSummary(name, f, draft) ? ` · ${configSummary(name, f, draft)}` : ''}</span>
                  ) : st.kind === 'modified' ? (
                    <span style={{ color: 'var(--st-review-fg)', fontWeight: 600 }}>MODIFIED · {st.what}</span>
                  ) : (
                    configSummary(name, f, draft)
                  )}
                </span>
                <button title="make this the ★ title field" onClick={() => set({ titleField: name })} style={starBtn(name === draft.titleField)}>★</button>
                <button title="make this the ⚑ slug field" onClick={() => set({ slugField: draft.slugField === name ? '' : name })} style={starBtn(name === draft.slugField)}>⚑</button>
                <Button size="sm" onClick={() => setEditing(i)}>Edit</Button>
                <button title="remove field" onClick={() => set({ fields: draft.fields.filter((_, j) => j !== i) })} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)' }}>✕</button>
              </div>
            );
          })}
          {removed.length > 0 && (
            <div style={{ padding: '8px 0', fontSize: 12, color: 'var(--st-danger-fg)' }}>
              {removed.map((n) => (
                <div key={n} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ fontWeight: 600 }}>REMOVED</span>
                  <Mono style={{ fontSize: 12, color: 'inherit', textDecoration: 'line-through' }}>{n}</Mono>
                  <span style={{ color: 'var(--muted)' }}>v{nextVersion} simply doesn't carry the column</span>
                  <button
                    onClick={() => set({ fields: [...draft.fields, [n, baseline!.fields[n]]] })}
                    style={{ font: 'inherit', fontSize: 11.5, color: 'var(--link)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                  >
                    restore
                  </button>
                </div>
              ))}
            </div>
          )}
          <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
            <Button size="sm" onClick={() => setEditing('add')}>+ Add field</Button>
            {!fieldNames.includes(draft.titleField) && <span style={{ fontSize: 12, color: 'var(--st-danger-fg)' }}>pick a title field (★)</span>}
          </div>
        </Card>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>What happens on save</div>
            {[
              <>DSL compiles your edits to <Mono style={{ fontSize: 11 }}>CREATE TABLE ct_{nextDef.key}_v{nextVersion}</Mono>{version > 0 ? ' + a backfill step' : ''}.</>,
              <>The migration waits for review — nothing is live yet.</>,
              <>Once admitted, each site scope applies it lazily on next open.</>,
            ].map((step, i) => (
              <div key={i} style={{ display: 'flex', gap: 10, marginBottom: 8, fontSize: 12.5, color: 'var(--muted)' }}>
                <span style={{ flex: '0 0 18px', height: 18, borderRadius: 'var(--r-pill)', background: 'var(--accent-soft)', color: 'var(--accent)', fontSize: 11, fontWeight: 600, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{i + 1}</span>
                <span style={{ lineHeight: 1.5 }}>{step}</span>
              </div>
            ))}
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)', fontSize: 11.5, color: 'var(--faint)', lineHeight: 1.5 }}>
              Deleting or retyping a field is append-only too — the new version simply doesn't carry the column; old revisions stay readable in <Mono style={{ fontSize: 11 }}>ct_{nextDef.key}_v{Math.max(version, 1)}</Mono>.
            </div>
          </Card>
        </div>
      </div>

      {editing !== null && (
        <FieldEditorModal
          ownerTitle={draft.title || 'New model'}
          fieldName={editing === 'add' ? null : draft.fields[editing][0]}
          initial={editing === 'add' ? null : draft.fields[editing][1]}
          existingNames={fieldNames}
          targets={types.map((t) => t.def).filter((d) => d.key !== draft.key)}
          onClose={() => setEditing(null)}
          onStage={(name, f) => {
            if (editing === 'add') set({ fields: [...draft.fields, [name, f]] });
            else set({ fields: draft.fields.map((row, j) => (j === editing ? [name, f] : row)) });
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

const inp: CSSProperties = { font: 'inherit', fontSize: 13, padding: '6px 9px', borderRadius: 'var(--r-input)', border: '1px solid var(--border2)', background: 'var(--surface)', color: 'var(--ink)' };

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, fontWeight: 600, color: 'var(--muted)' }}>
      {label}
      {children}
    </label>
  );
}

const starBtn = (on: boolean): CSSProperties => ({ border: 'none', background: 'none', cursor: 'pointer', fontSize: 13, color: on ? 'var(--accent)' : 'var(--faint)', padding: 0 });

// ── Screen 9 · the field editor modal ───────────────────────────────────────

const REQUIRED_NOTE: Partial<Record<FieldType, string>> = {
  ref: 'delivery omits entries whose ref is unresolved',
  refMany: 'delivery omits unresolved targets from the list',
  assetRef: 'the form requires an asset before an entry can be saved',
};

function FieldEditorModal(props: {
  ownerTitle: string;
  fieldName: string | null; // null = adding a new field
  initial: FieldDef | null;
  existingNames: string[];
  targets: ContentTypeDef[];
  onClose: () => void;
  onStage: (name: string, f: FieldDef) => void;
}) {
  const [name, setName] = useState(props.fieldName ?? '');
  const [f, setF] = useState<FieldDef>(props.initial ?? { type: 'text' });
  const isRef = f.type === 'ref' || f.type === 'refMany';
  const nameClash = props.fieldName === null && props.existingNames.includes(name);
  const valid = /^[a-zA-Z][a-zA-Z0-9_]*$/.test(name) && !nameClash && (!isRef || !!f.target);
  const reason = !name
    ? 'Name the field first.'
    : nameClash
      ? 'A field with this name already exists.'
      : !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)
        ? 'Field names are letters, digits and _ (starting with a letter).'
        : isRef && !f.target
          ? 'Pick a target type — a reference needs somewhere to point.'
          : '';

  return (
    <Modal onClose={props.onClose} width={680}>
      <div style={{ padding: '14px 18px 10px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>Field editor</div>
        <Mono style={{ fontSize: 11.5 }}>{props.ownerTitle} › {props.fieldName ?? 'new field'}</Mono>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '250px 1fr', gap: 0, flex: 1, minHeight: 0 }}>
        {/* The §4 type grid — every type with the column shape it maps to. */}
        <div style={{ borderRight: '1px solid var(--border)', padding: '12px 14px', overflow: 'auto' }}>
          <MicroLabel>Field type</MicroLabel>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 4 }}>
            {FIELD_TYPES.map((t) => {
              const on = f.type === t;
              const label = t === 'ref' ? 'ref(Type)' : t === 'refMany' ? 'refMany(Type)' : t === 'int' ? 'int / number' : t;
              return (
                <button
                  key={t}
                  onClick={() => setF({ ...f, type: t, ...(t === 'ref' || t === 'refMany' ? {} : { target: undefined }), ...(t === 'enum' ? {} : { options: undefined }) })}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 8,
                    font: 'inherit',
                    fontSize: 12.5,
                    fontWeight: on ? 600 : 500,
                    padding: '6px 10px',
                    borderRadius: 'var(--r-input)',
                    border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                    background: on ? 'var(--accent-soft)' : 'transparent',
                    color: on ? 'var(--accent)' : 'var(--ink)',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <span style={{ fontFamily: 'var(--mono)' }}>{label}</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: on ? 'var(--accent)' : 'var(--faint)' }}>{TYPE_CHIP[t]}</span>
                </button>
              );
            })}
          </div>
          <div style={{ marginTop: 12, fontSize: 11.5, color: 'var(--faint)', lineHeight: 1.5 }}>
            Every type maps to a known column shape — the DSL can only emit table-shaped SQL. That boundedness is the safety argument.
          </div>
        </div>

        {/* Configure the selected type. */}
        <div style={{ padding: '12px 18px', overflow: 'auto' }}>
          <MicroLabel>Configure · {f.type === 'ref' || f.type === 'refMany' ? `${f.type}(Type)` : f.type}</MicroLabel>
          <Labeled label="Field name">
            <input autoFocus={props.fieldName === null} value={name} onChange={(e) => setName(e.target.value)} placeholder="author" style={{ ...inp, fontFamily: 'var(--mono)', width: 220 }} />
          </Labeled>

          {isRef && (
            <div style={{ marginTop: 14 }}>
              <MicroLabel style={{ marginBottom: 6 }}>Target type</MicroLabel>
              {props.targets.map((t) => {
                const on = f.target === t.key;
                return (
                  <button
                    key={t.key}
                    onClick={() => setF({ ...f, target: t.key })}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', font: 'inherit', fontSize: 13, padding: '7px 10px', marginBottom: 3, borderRadius: 'var(--r-input)', border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`, background: on ? 'var(--accent-soft)' : 'transparent', color: 'var(--ink)', cursor: 'pointer', textAlign: 'left' }}
                  >
                    <span style={{ flex: 1, fontWeight: on ? 600 : 500 }}>{t.title}</span>
                    <Mono style={{ fontSize: 10.5 }}>ct_{t.key}_v{t.version}</Mono>
                    {on && <span style={{ color: 'var(--accent)', fontWeight: 700 }}>✓</span>}
                  </button>
                );
              })}
              <div style={{ marginTop: 6, fontSize: 11.5, color: 'var(--faint)', lineHeight: 1.5 }}>
                Stored as a ULID into the entry spine — survives the target's schema changes.
              </div>
            </div>
          )}

          {f.type === 'enum' && (
            <div style={{ marginTop: 14 }}>
              <Labeled label="Options (a | b | c)">
                <input value={(f.options ?? []).join(' | ')} onChange={(e) => setF({ ...f, options: e.target.value.split('|').map((s) => s.trim()).filter(Boolean) })} placeholder="news | guide | release" style={{ ...inp, width: 260 }} />
              </Labeled>
            </div>
          )}
          {f.type === 'slug' && (
            <div style={{ marginTop: 14 }}>
              <Labeled label="Derive from field">
                <select value={f.source ?? ''} onChange={(e) => setF({ ...f, source: e.target.value || undefined })} style={{ ...inp, width: 200 }}>
                  <option value="">—</option>
                  {props.existingNames.filter((n) => n !== name).map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </Labeled>
            </div>
          )}
          {(f.type === 'text' || f.type === 'richText') && (
            <div style={{ marginTop: 14 }}>
              <Labeled label="Max length (optional)">
                <input type="number" value={f.maxLen ?? ''} onChange={(e) => setF({ ...f, maxLen: e.target.value ? Number(e.target.value) : undefined })} placeholder="60" style={{ ...inp, width: 110 }} />
              </Labeled>
            </div>
          )}

          <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <input type="checkbox" checked={!!f.required} onChange={(e) => setF({ ...f, required: e.target.checked || undefined })} />
              <span style={{ fontWeight: 600 }}>Required</span>
              <span style={{ fontSize: 11.5, color: 'var(--faint)' }}>{REQUIRED_NOTE[f.type as FieldType] ?? 'the form requires a value before an entry can be saved'}</span>
            </label>
            {SQL_COLUMN[f.type as FieldType] && (
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <input type="checkbox" checked={!!f.index} onChange={(e) => setF({ ...f, index: e.target.checked || undefined })} />
                <span style={{ fontWeight: 600 }}>Indexed</span>
                <span style={{ fontSize: 11.5, color: 'var(--faint)' }}>adds CREATE INDEX to the staged migration</span>
              </label>
            )}
          </div>
        </div>
      </div>
      <div style={{ borderTop: '1px solid var(--border)', padding: '10px 18px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 11.5, color: 'var(--faint)' }}>The primary action stages the change — nothing saves live.</span>
        <div style={{ flex: 1 }} />
        <Button onClick={props.onClose}>Cancel</Button>
        <Button variant="primary" disabled={!valid} title={reason} onClick={() => props.onStage(name, f)}>Stage change</Button>
      </div>
    </Modal>
  );
}

// ── Screen 11a · migration review (diff-first, pre-admission) ───────────────

function DiffLine({ line }: { line: string }) {
  if (line.startsWith('--')) return <div style={{ color: '#7a7a88', padding: '0 4px' }}>{line}</div>;
  return <div style={{ background: 'var(--diff-add-bg)', color: 'var(--diff-add-fg)', padding: '0 4px' }}>+ {line}</div>;
}

function MigrationReview(props: {
  nextDef: ContentTypeDef;
  baseline: ContentTypeDef | null;
  stagedCount: number;
  busy: boolean;
  err: string;
  onBack: () => void;
  onDiscard: () => void;
  onAdmit: () => void;
}) {
  const { nextDef, baseline } = props;
  const [sites, setSites] = useState<Site[]>([]);
  useEffect(() => { api.sites().then(setSites).catch(() => setSites([])); }, []);
  const backfill = backfillSql(nextDef, baseline);
  const lines = [
    `-- generated by defineContentType('${nextDef.key}', v${nextDef.version})`,
    ...compileTypeToSql(nextDef).split('\n'),
    ...(backfill
      ? ['-- backfill step (resumable, per scope)', ...backfill.split('\n'), `-- ct_${nextDef.key}_v${baseline!.version} is never altered or dropped`]
      : ['-- initial version — nothing to backfill']),
  ];

  return (
    <div>
      <button onClick={props.onBack} style={{ font: 'inherit', fontSize: 12.5, color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginBottom: 10 }}>← keep editing</button>
      <ProductTitle sub="The SQL is the artifact; admission rides alongside. The reviewer reads a table, not a form.">Review migration</ProductTitle>

      {props.err && <div style={{ padding: '10px 14px', borderRadius: 'var(--r-input)', background: 'var(--st-danger-bg)', color: 'var(--st-danger-fg)', fontSize: 13, marginBottom: 14 }}>{props.err}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 16, alignItems: 'start' }}>
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
            <Mono style={{ fontSize: 13, color: 'var(--ink)', fontWeight: 600 }}>{migrationId(nextDef.key, nextDef.version)}</Mono>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', padding: '2px 9px', borderRadius: 'var(--r-pill)', background: 'var(--st-review-bg)', color: 'var(--st-review-fg)' }}>PENDING REVIEW</span>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>staged by you · from {props.stagedCount} model edit{props.stagedCount === 1 ? '' : 's'}</span>
            <div style={{ flex: 1 }} />
            <Button size="sm" disabled={props.busy} onClick={props.onDiscard}>Discard</Button>
            <Button size="sm" variant="primary" disabled={props.busy} onClick={props.onAdmit}>{props.busy ? 'Admitting…' : 'Propose for admission'}</Button>
          </div>
          <pre style={{ margin: 0, padding: 14, background: 'var(--code-bg)', color: 'var(--code-ink)', fontFamily: 'var(--mono)', fontSize: 11.5, lineHeight: 1.6, overflow: 'auto' }}>
            {lines.map((l, i) => <DiffLine key={i} line={l} />)}
          </pre>
        </Card>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card>
            <MicroLabel>Admission</MicroLabel>
            {[
              { label: 'Pending review', on: true },
              { label: 'Admitted', on: false },
              { label: 'Applied per scope', on: false },
            ].map((s) => (
              <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0', fontSize: 13 }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: s.on ? 'var(--accent)' : 'transparent', border: `2px solid ${s.on ? 'var(--accent)' : 'var(--border2)'}` }} />
                <span style={{ fontWeight: s.on ? 600 : 400, color: s.on ? 'var(--ink)' : 'var(--muted)' }}>{s.label}</span>
              </div>
            ))}
          </Card>
          <Card>
            <MicroLabel>Apply · lazy per site</MicroLabel>
            {(sites.length ? sites : [{ slug: '·', name: '…' }]).map((s) => (
              <div key={s.slug} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 12.5 }}>
                <Mono style={{ fontSize: 12, color: 'var(--ink)' }}>{s.slug}</Mono>
                <span style={{ color: 'var(--faint)' }}>awaiting admission</span>
              </div>
            ))}
            <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--faint)', lineHeight: 1.5 }}>
              What's admitted is exactly this SQL.
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ── Screen 11b · Migrations (plan-first, post-admission) ────────────────────

function ProgressBar({ pct, tone }: { pct: number; tone: 'done' | 'active' | 'cold' }) {
  const fill = tone === 'done' ? 'var(--st-published-fg)' : tone === 'active' ? 'var(--accent)' : 'transparent';
  return (
    <div style={{ flex: 1, height: 6, borderRadius: 'var(--r-pill)', background: 'var(--wash)', overflow: 'hidden' }}>
      <div style={{ width: `${pct}%`, height: '100%', background: fill, transition: 'width 200ms ease' }} />
    </div>
  );
}

function PlanStep({ tag, title, detail, sql }: { tag: string; title: ReactNode; detail?: ReactNode; sql?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ padding: '9px 0', borderBottom: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 700, letterSpacing: '0.05em', padding: '2px 8px', borderRadius: 5, background: 'var(--accent-soft)', color: 'var(--accent)' }}>{tag}</span>
        <span style={{ fontSize: 13 }}>{title}</span>
        <div style={{ flex: 1 }} />
        {sql && (
          <button onClick={() => setOpen(!open)} style={{ font: 'inherit', fontSize: 11.5, color: 'var(--link)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
            view SQL {open ? '▴' : '▾'}
          </button>
        )}
      </div>
      {detail && <div style={{ marginTop: 3, marginLeft: 2, fontSize: 12, color: 'var(--muted)' }}>{detail}</div>}
      {open && sql && (
        <pre style={{ margin: '8px 0 0', padding: 12, background: 'var(--code-bg)', color: 'var(--code-ink)', fontFamily: 'var(--mono)', fontSize: 11, lineHeight: 1.6, borderRadius: 'var(--r-input)', overflow: 'auto' }}>{sql}</pre>
      )}
    </div>
  );
}

export function MigrationsView() {
  const { types } = useTypes();
  const [sites, setSites] = useState<Site[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    api.sites().then(setSites).catch(() => setSites([]));
    api.listEntries().then((all) => {
      const by: Record<string, number> = {};
      for (const e of all) by[e.type_key] = (by[e.type_key] ?? 0) + 1;
      setCounts(by);
    }).catch(() => setCounts({}));
  }, []);
  const activeSite = getSite();

  return (
    <div>
      <ProductTitle sub="Every content-model change compiles to a reviewed migration — never a live ALTER. Admitted migrations apply lazily, per scope, on next open.">Migrations</ProductTitle>
      {types.map(({ def }) => {
        const scalarCols = Object.entries(def.fields).filter(([, f]) => SQL_COLUMN[f.type as FieldType]).map(([n]) => n);
        const indexed = Object.entries(def.fields).filter(([, f]) => f.index).map(([n]) => n);
        const n = counts[def.key] ?? 0;
        const prevV = def.version - 1;
        return (
          <Card key={def.key} style={{ padding: 0, overflow: 'hidden', marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
              <Mono style={{ fontSize: 12.5, color: 'var(--ink)', fontWeight: 600 }}>{migrationId(def.key, def.version)}</Mono>
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', padding: '2px 9px', borderRadius: 'var(--r-pill)', background: 'var(--st-published-bg)', color: 'var(--st-published-fg)' }}>ADMITTED</span>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>applying lazily</span>
              <div style={{ flex: 1 }} />
              <Mono style={{ fontSize: 11 }}>{def.title} · {Object.keys(def.fields).length} fields</Mono>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 0 }}>
              <div style={{ padding: '6px 16px 12px', borderRight: '1px solid var(--border)' }}>
                <MicroLabel style={{ marginTop: 8 }}>Plan · {def.version > 1 ? `model edits → 3 steps` : 'initial version → 2 steps'}</MicroLabel>
                <PlanStep
                  tag="CREATE"
                  title={<><Mono style={{ fontSize: 12, color: 'var(--ink)' }}>ct_{def.key}_v{def.version}</Mono> — {scalarCols.length} columns{indexed.length ? <> · indexes <Mono style={{ fontSize: 11.5 }}>{indexed.join(', ')}</Mono></> : ''}</>}
                  sql={compileTypeToSql(def)}
                />
                {def.version > 1 && (
                  <PlanStep
                    tag="BACKFILL"
                    title={<>copy v{prevV} rows → v{def.version} · resumable · new writes go to v{def.version} immediately</>}
                    sql={`INSERT INTO ct_${def.key}_v${def.version}\n  SELECT entry_id, rev_no, ${scalarCols.join(', ')}\n  FROM ct_${def.key}_v${prevV};`}
                  />
                )}
                <PlanStep
                  tag="CUTOVER"
                  title={<>entry spine <Mono style={{ fontSize: 12 }}>type_version</Mono> flips per entry{def.version > 1 ? <> · v{prevV} stays readable</> : ''}</>}
                />
              </div>
              <div style={{ padding: '6px 16px 12px' }}>
                <MicroLabel style={{ marginTop: 8 }}>Apply progress · per scope, lazy on next open</MicroLabel>
                {(sites.length ? sites : []).map((s) => {
                  const active = s.slug === activeSite;
                  return (
                    <div key={s.slug} style={{ padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <Mono style={{ fontSize: 12, color: 'var(--ink)', width: 44 }}>{s.slug}</Mono>
                        <ProgressBar pct={active ? 100 : 0} tone={active ? 'done' : 'cold'} />
                      </div>
                      <div style={{ marginTop: 3, marginLeft: 54, fontSize: 11.5, color: active ? 'var(--st-published-fg)' : 'var(--faint)' }}>
                        {active ? `applied · ${n}/${n} backfilled` : 'cold · applies on next open'}
                      </div>
                    </div>
                  );
                })}
                {sites.length === 0 && <div style={{ fontSize: 12, color: 'var(--faint)', padding: '6px 0' }}>No sites yet.</div>}
              </div>
            </div>
          </Card>
        );
      })}
      <div style={{ marginTop: 4, padding: '12px 16px', border: '1px dashed var(--border2)', borderRadius: 'var(--r-card)', fontSize: 12.5, color: 'var(--muted)' }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--faint)', marginRight: 8 }}>NOTE</span>
        “Save” proposed a schema change; admission was the checkpoint; apply is per-scope and non-blocking. A cold
        scope simply applies on next open — lazy, not mysterious.
      </div>
    </div>
  );
}

// ── Screen 10 · Relationship map (force layout, pan/zoom in-container) ──────

interface MapNode { key: string; title: string; sub: string; kind: 'type' | 'assets'; x: number; y: number }
interface MapEdge { from: string; to: string; label: string; kind: 'ref' | 'refMany' | 'asset' }

const NODE_W = 168;
const NODE_H = 62;

/** Deterministic force layout: circle init (by index), repulsion + edge springs + gravity. */
function layout(nodes: MapNode[], edges: MapEdge[]): void {
  const R = 190 + nodes.length * 14;
  nodes.forEach((n, i) => {
    const a = (2 * Math.PI * i) / nodes.length;
    n.x = Math.cos(a) * R;
    n.y = Math.sin(a) * R * 0.72;
  });
  const idx = new Map(nodes.map((n) => [n.key, n]));
  for (let it = 0; it < 260; it++) {
    const t = 1 - it / 260;
    for (const a of nodes) {
      let fx = -a.x * 0.012, fy = -a.y * 0.012; // gravity toward center
      for (const b of nodes) {
        if (a === b) continue;
        const dx = a.x - b.x, dy = (a.y - b.y) * 1.6; // stronger vertical separation (nodes are wide)
        const d2 = Math.max(dx * dx + dy * dy, 900);
        const rep = 340000 / d2;
        const d = Math.sqrt(d2);
        fx += (dx / d) * rep * 0.01;
        fy += (dy / d) * rep * 0.01;
      }
      for (const e of edges) {
        if (e.from !== a.key && e.to !== a.key) continue;
        const other = idx.get(e.from === a.key ? e.to : e.from);
        if (!other) continue;
        const dx = other.x - a.x, dy = other.y - a.y;
        const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
        const pull = (d - 250) * 0.004;
        fx += (dx / d) * pull * d;
        fy += (dy / d) * pull * d;
      }
      a.x += fx * t;
      a.y += fy * t;
    }
  }
}

/** Where an edge meets a node's rounded-rect border, aiming at (tx, ty). */
function anchor(n: MapNode, tx: number, ty: number): { x: number; y: number } {
  const dx = tx - n.x, dy = ty - n.y;
  const sx = dx === 0 ? Infinity : (NODE_W / 2 + 6) / Math.abs(dx);
  const sy = dy === 0 ? Infinity : (NODE_H / 2 + 6) / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: n.x + dx * s, y: n.y + dy * s };
}

export function RelationshipMap({ onOpen }: { onOpen?: (key: string) => void }) {
  const { types } = useTypes();
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const pan = useRef<{ px: number; py: number; vx: number; vy: number } | null>(null);

  useEffect(() => {
    api.listEntries().then((all: EntryListItem[]) => {
      const by: Record<string, number> = {};
      for (const e of all) by[e.type_key] = (by[e.type_key] ?? 0) + 1;
      setCounts(by);
    }).catch(() => setCounts({}));
  }, []);

  const { nodes, edges } = useMemo(() => {
    const defs = types.map((t) => t.def);
    const nodes: MapNode[] = defs.map((d) => ({
      key: d.key,
      title: d.title,
      sub: `v${d.version} · ${Object.keys(d.fields).length} fields · ${counts[d.key] ?? 0} entries`,
      kind: 'type',
      x: 0,
      y: 0,
    }));
    const edges: MapEdge[] = [];
    let hasAssets = false;
    for (const d of defs) {
      const assetFields: string[] = [];
      for (const [name, f] of Object.entries(d.fields)) {
        if ((f.type === 'ref' || f.type === 'refMany') && f.target && defs.some((x) => x.key === f.target)) {
          edges.push({ from: d.key, to: f.target, label: `${f.type} · ${name}`, kind: f.type });
        } else if (f.type === 'assetRef' || f.type === 'assetRefMany') {
          assetFields.push(name);
        }
      }
      if (assetFields.length) {
        hasAssets = true;
        edges.push({ from: d.key, to: '·assets', label: `assetRef · ${assetFields.join(', ')}`, kind: 'asset' });
      }
    }
    if (hasAssets) nodes.push({ key: '·assets', title: 'Assets', sub: 'media library · not a content type', kind: 'assets', x: 0, y: 0 });
    layout(nodes, edges);
    return { nodes, edges };
  }, [types, counts]);

  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const W = 860, H = 470;

  const legendChip = (label: string, swatch: ReactNode) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--muted)' }}>
      <svg width={26} height={10}>{swatch}</svg>
      {label}
    </span>
  );

  return (
    <div>
      <ProductTitle sub="Content types as nodes, references as directed edges — updates live as you model.">Relationships</ProductTitle>
      <div style={{ display: 'flex', gap: 20, marginBottom: 10, alignItems: 'center' }}>
        {legendChip('ref (single)', <line x1={0} y1={5} x2={26} y2={5} stroke="var(--accent)" strokeWidth={1.6} />)}
        {legendChip('refMany', <><line x1={0} y1={3} x2={26} y2={3} stroke="var(--accent)" strokeWidth={1.4} /><line x1={0} y1={7} x2={26} y2={7} stroke="var(--accent)" strokeWidth={1.4} /></>)}
        {legendChip('assetRef', <line x1={0} y1={5} x2={26} y2={5} stroke="var(--faint)" strokeWidth={1.6} strokeDasharray="4 3" />)}
      </div>
      <Card style={{ padding: 0, overflow: 'hidden', position: 'relative' }}>
        <svg
          width="100%"
          height={H}
          viewBox={`${-W / 2 / view.k - view.x} ${-H / 2 / view.k - view.y} ${W / view.k} ${H / view.k}`}
          style={{ display: 'block', cursor: pan.current ? 'grabbing' : 'grab', touchAction: 'none' }}
          onPointerDown={(e) => {
            pan.current = { px: e.clientX, py: e.clientY, vx: view.x, vy: view.y };
            (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!pan.current) return;
            setView((v) => ({ ...v, x: pan.current!.vx + (e.clientX - pan.current!.px) / v.k, y: pan.current!.vy + (e.clientY - pan.current!.py) / v.k }));
          }}
          onPointerUp={() => { pan.current = null; }}
          onWheel={(e) => {
            setView((v) => ({ ...v, k: Math.min(2.5, Math.max(0.4, v.k * (e.deltaY < 0 ? 1.12 : 0.9))) }));
          }}
        >
          <defs>
            <marker id="arr" viewBox="0 0 10 10" refX={9} refY={5} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)" />
            </marker>
            <marker id="arrg" viewBox="0 0 10 10" refX={9} refY={5} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--faint)" />
            </marker>
          </defs>

          {edges.map((e, i) => {
            const a = byKey.get(e.from), b = byKey.get(e.to);
            if (!a || !b) return null;
            const p1 = anchor(a, b.x, b.y), p2 = anchor(b, a.x, a.y);
            const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
            // Bow the curve perpendicular to the edge so parallel edges don't overlap.
            const dx = p2.x - p1.x, dy = p2.y - p1.y;
            const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
            const nx = -dy / d, ny = dx / d;
            const bow = 16 + (i % 3) * 10;
            const cx = mx + nx * bow, cy = my + ny * bow;
            const stroke = e.kind === 'asset' ? 'var(--faint)' : 'var(--accent)';
            const marker = e.kind === 'asset' ? 'url(#arrg)' : 'url(#arr)';
            const path = (off: number) => {
              const ox = nx * off, oy = ny * off;
              return `M ${p1.x + ox} ${p1.y + oy} Q ${cx + ox} ${cy + oy} ${p2.x + ox} ${p2.y + oy}`;
            };
            const lx = mx + nx * (bow * 0.7), ly = my + ny * (bow * 0.7);
            return (
              <g key={i}>
                {e.kind === 'refMany' ? (
                  <>
                    <path d={path(-1.6)} fill="none" stroke={stroke} strokeWidth={1.3} />
                    <path d={path(1.6)} fill="none" stroke={stroke} strokeWidth={1.3} markerEnd={marker} />
                  </>
                ) : (
                  <path d={path(0)} fill="none" stroke={stroke} strokeWidth={1.4} strokeDasharray={e.kind === 'asset' ? '5 4' : undefined} markerEnd={marker} />
                )}
                <g>
                  <rect x={lx - e.label.length * 2.9 - 5} y={ly - 8} width={e.label.length * 5.8 + 10} height={16} rx={8} fill="var(--surface)" opacity={0.92} />
                  <text x={lx} y={ly + 3.5} fontSize={9.5} fontFamily="var(--mono)" fill="var(--muted)" textAnchor="middle">{e.label}</text>
                </g>
              </g>
            );
          })}

          {nodes.map((n) => {
            const on = selected === n.key;
            const isType = n.kind === 'type';
            return (
              <g key={n.key} style={{ cursor: isType ? 'pointer' : 'default' }} onClick={(ev) => { ev.stopPropagation(); if (isType) setSelected(on ? null : n.key); }}>
                <rect
                  x={n.x - NODE_W / 2}
                  y={n.y - NODE_H / 2}
                  width={NODE_W}
                  height={NODE_H}
                  rx={12}
                  fill={isType ? 'var(--surface)' : 'var(--wash)'}
                  stroke={on ? 'var(--accent)' : isType ? 'var(--border2)' : 'var(--border2)'}
                  strokeWidth={on ? 2.2 : 1.4}
                  strokeDasharray={isType ? undefined : '5 4'}
                />
                <text x={n.x - NODE_W / 2 + 14} y={n.y - 6} fontSize={14} fontWeight={600} fill={isType ? 'var(--ink)' : 'var(--muted)'}>{n.title}</text>
                <text x={n.x - NODE_W / 2 + 14} y={n.y + 13} fontSize={9.8} fontFamily="var(--mono)" fill="var(--muted)">{n.sub}</text>
                {on && isType && onOpen && (
                  <text
                    x={n.x - NODE_W / 2 + 14}
                    y={n.y + NODE_H / 2 + 16}
                    fontSize={11}
                    fontWeight={600}
                    fill="var(--accent)"
                    style={{ cursor: 'pointer' }}
                    onClick={(ev) => { ev.stopPropagation(); onOpen(n.key); }}
                  >
                    Open model →
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        <div style={{ position: 'absolute', right: 12, bottom: 10, fontSize: 11, color: 'var(--faint)', background: 'var(--surface)', padding: '3px 10px', borderRadius: 'var(--r-pill)', border: '1px solid var(--border)' }}>
          drag to pan · scroll to zoom
        </div>
      </Card>
    </div>
  );
}
