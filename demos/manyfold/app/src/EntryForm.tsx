import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { getSite, type ContentTypeDef, type FieldDef } from './api';
import { AssetDrawer } from './AssetsView';
import { MarkdownEditor } from './Markdown';
import { RefChipRow, RefCombobox, RefModalPicker, useTargetEntries } from './Pickers';
import { AssetStripe, Avatar, Button, Card, Mono, StatusBadge } from './ui';

// The field-driven entry form: one control per field type, built from the content-type
// definition. Used for both create (new entry) and edit (a new draft revision).
// Every label carries the field's DSL type in mono microtext; validation errors render
// inline in the danger pair (red border + bg + the reason string) per the design mock.

const inputStyle: CSSProperties = {
  font: 'inherit',
  fontSize: 13.5,
  width: '100%',
  padding: '8px 10px',
  borderRadius: 'var(--r-input)',
  border: '1px solid var(--border2)',
  background: 'var(--surface)',
  color: 'var(--ink)',
};

const invalidStyle: CSSProperties = { border: '1px solid var(--st-danger-fg)', background: 'var(--st-danger-bg)' };

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** The mono microtext after each label — the DSL type plus its load-bearing config. */
function typeNote(name: string, f: FieldDef, def: ContentTypeDef): string {
  const bits: string[] = [];
  if (f.type === 'ref' || f.type === 'refMany') bits.push(`${f.type}(${f.target ?? '?'})`);
  else bits.push(f.type);
  if (f.type === 'slug') bits.push(f.source ? `from ${f.source} · unique per site` : 'unique per site');
  if (f.type === 'richText') bits.push('markdown');
  if (f.type === 'refMany') bits.push('reorderable');
  if (f.required) bits.push('required');
  if (f.maxLen) bits.push(`max ${f.maxLen}`);
  if (f.index) bits.push('indexed');
  if (name === def.titleField) bits.push('★');
  return bits.join(' · ');
}

const isEmpty = (v: unknown): boolean => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

export function EntryForm(props: {
  def: ContentTypeDef;
  types: ContentTypeDef[];
  /** When editing an existing entry — excluded from the slug-uniqueness check. */
  entryId?: string;
  initial?: Record<string, unknown>;
  submitLabel: string;
  onSubmit: (body: Record<string, unknown>) => void;
  onCancel: () => void;
  error?: string;
}) {
  const [body, setBody] = useState<Record<string, unknown>>(props.initial ?? {});
  const [attempted, setAttempted] = useState(false);
  const set = (name: string, value: unknown) => setBody((b) => ({ ...b, [name]: value }));

  // Auto-derive slug from its source field until the user edits the slug directly.
  const [slugTouched, setSlugTouched] = useState(!!props.initial);
  const slugSource = props.def.slugField ? props.def.fields[props.def.slugField]?.source : undefined;
  useEffect(() => {
    if (props.def.slugField && !slugTouched && slugSource && typeof body[slugSource] === 'string') {
      set(props.def.slugField, slugify(body[slugSource] as string));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slugSource ? body[slugSource] : undefined]);

  // Slug uniqueness — checked against the site's real entries (excluding this one).
  const siblings = useTargetEntries(props.def.slugField ? props.def.key : undefined);
  const slugValue = props.def.slugField ? (body[props.def.slugField] as string | undefined) : undefined;
  const slugClash = useMemo(
    () => siblings.find((e) => e.slug && e.slug === slugValue && e.id !== props.entryId),
    [siblings, slugValue, props.entryId],
  );

  // Live errors: maxLen always, required after a submit attempt, slug clashes always.
  const errors = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [name, f] of Object.entries(props.def.fields)) {
      const v = body[name];
      if (f.maxLen && typeof v === 'string' && v.length > f.maxLen) out[name] = `Max ${f.maxLen} characters — currently ${v.length}.`;
      else if (attempted && f.required && isEmpty(v)) out[name] = 'Required.';
    }
    if (props.def.slugField && slugClash) out[props.def.slugField] = `Already used by “${slugClash.title}” in ${getSite()}.`;
    return out;
  }, [props.def, body, attempted, slugClash]);

  const clean = (): Record<string, unknown> => {
    // Drop empty optionals so the backend Zod (optional) is satisfied.
    const out: Record<string, unknown> = {};
    for (const [name, f] of Object.entries(props.def.fields)) {
      const v = body[name];
      if (isEmpty(v)) {
        if (f.required) out[name] = v ?? '';
        continue;
      }
      out[name] = v;
    }
    return out;
  };

  const submit = () => {
    setAttempted(true);
    const hard = Object.entries(props.def.fields).some(([name, f]) => (f.required && isEmpty(body[name])) || (f.maxLen && typeof body[name] === 'string' && (body[name] as string).length > f.maxLen!));
    if (hard || slugClash) return;
    props.onSubmit(clean());
  };

  return (
    <Card style={{ maxWidth: 720 }}>
      {props.error && (
        <div style={{ padding: '10px 14px', borderRadius: 'var(--r-input)', background: 'var(--st-danger-bg)', color: 'var(--st-danger-fg)', fontSize: 13, marginBottom: 14 }}>
          {props.error}
        </div>
      )}
      {Object.entries(props.def.fields).map(([name, f]) => (
        <div key={name} style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 5 }}>
            {name} <Mono style={{ fontSize: 11 }}>{typeNote(name, f, props.def)}</Mono>
          </label>
          <FieldControl
            name={name}
            f={f}
            def={props.def}
            types={props.types}
            value={body[name]}
            invalid={!!errors[name]}
            onChange={(v) => {
              if (props.def.slugField === name) setSlugTouched(true);
              set(name, v);
            }}
          />
          {props.def.slugField === name && !errors[name] && slugValue && (
            <div style={{ marginTop: 4, fontSize: 11.5, color: 'var(--st-published-fg)', display: 'flex', gap: 12, alignItems: 'center' }}>
              <span>✓ unique in {getSite()}</span>
              {slugSource && typeof body[slugSource] === 'string' && (
                <button
                  onClick={() => { set(name, slugify(body[slugSource!] as string)); setSlugTouched(false); }}
                  style={{ font: 'inherit', fontSize: 11.5, color: 'var(--link)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                >
                  Re-derive from {slugSource}
                </button>
              )}
            </div>
          )}
          {errors[name] && <div style={{ marginTop: 4, fontSize: 11.5, color: 'var(--st-danger-fg)' }}>{errors[name]}</div>}
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
        <Button variant="primary" onClick={submit}>{props.submitLabel}</Button>
        <Button onClick={props.onCancel}>Cancel</Button>
        {attempted && Object.keys(errors).length > 0 && (
          <span style={{ fontSize: 12, color: 'var(--st-danger-fg)' }}>Fix the highlighted field{Object.keys(errors).length === 1 ? '' : 's'} first.</span>
        )}
      </div>
    </Card>
  );
}

function FieldControl({ name, f, def, types, value, invalid, onChange }: {
  name: string;
  f: FieldDef;
  def: ContentTypeDef;
  types: ContentTypeDef[];
  value: unknown;
  invalid: boolean;
  onChange: (v: unknown) => void;
}) {
  const inp = invalid ? { ...inputStyle, ...invalidStyle } : inputStyle;
  switch (f.type) {
    case 'richText':
      return <MarkdownEditor value={(value as string) ?? ''} invalid={invalid} onChange={(v) => onChange(v || undefined)} />;
    case 'slug':
      return <input style={{ ...inp, fontFamily: 'var(--mono)', fontSize: 12.5 }} value={(value as string) ?? ''} onChange={(e) => onChange(slugify(e.target.value) || undefined)} />;
    case 'bool':
      return (
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13.5 }}>
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} /> {value ? 'yes' : 'no'}
        </label>
      );
    case 'int':
      return <input type="number" style={inp} value={(value as number) ?? ''} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />;
    case 'date':
      return <input type="date" style={{ ...inp, width: 200 }} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value || undefined)} />;
    case 'enum':
      return <SegmentedEnum options={f.options ?? []} value={value as string | undefined} required={!!f.required} onChange={onChange} />;
    case 'textArray':
      return <TagInput value={Array.isArray(value) ? (value as string[]) : []} onChange={(v) => onChange(v.length ? v : undefined)} />;
    case 'assetRef':
      return <AssetRefControl name={name} value={value as string | undefined} types={types} onChange={onChange} />;
    case 'assetRefMany':
      return <AssetRefManyControl name={name} value={Array.isArray(value) ? (value as string[]) : []} types={types} onChange={(v) => onChange(v.length ? v : undefined)} />;
    case 'ref':
      return <SingleRefField f={f} types={types} value={value as string | undefined} onChange={onChange} />;
    case 'refMany':
      return <ManyRefField f={f} def={def} types={types} fieldName={name} value={Array.isArray(value) ? (value as string[]) : []} onChange={(v) => onChange(v.length ? v : undefined)} />;
    default:
      return <input style={inp} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value || undefined)} />;
  }
}

// ── Enum as the mock's segmented control ────────────────────────────────────

function SegmentedEnum({ options, value, required, onChange }: { options: readonly string[]; value: string | undefined; required: boolean; onChange: (v: unknown) => void }) {
  return (
    <div style={{ display: 'inline-flex', border: '1px solid var(--border2)', borderRadius: 'var(--r-input)', overflow: 'hidden' }}>
      {options.map((o, i) => {
        const on = value === o;
        return (
          <button
            key={o}
            onClick={() => onChange(on && !required ? undefined : o)}
            style={{
              font: 'inherit',
              fontSize: 12.5,
              fontWeight: on ? 600 : 500,
              padding: '6px 14px',
              border: 'none',
              borderLeft: i > 0 ? '1px solid var(--border2)' : 'none',
              background: on ? 'var(--accent-soft)' : 'var(--surface)',
              color: on ? 'var(--accent)' : 'var(--muted)',
              cursor: 'pointer',
            }}
          >
            {o}
          </button>
        );
      })}
    </div>
  );
}

// ── textArray as a chip input ("coffee ✕ · suppliers ✕ · add tag…") ─────────

function TagInput({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const t = draft.trim().replace(/,$/, '');
    if (t && !value.includes(t)) onChange([...value, t]);
    setDraft('');
  };
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', padding: '5px 8px', borderRadius: 'var(--r-input)', border: '1px solid var(--border2)', background: 'var(--surface)' }}>
      {value.map((t) => (
        <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 9px', borderRadius: 'var(--r-pill)', background: 'var(--wash)', fontSize: 12.5 }}>
          {t}
          <button onClick={() => onChange(value.filter((x) => x !== t))} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 0, font: 'inherit' }}>✕</button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); }
          if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={add}
        placeholder={value.length ? 'add tag…' : 'add tags…'}
        style={{ flex: 1, minWidth: 90, font: 'inherit', fontSize: 13, border: 'none', outline: 'none', background: 'transparent', color: 'var(--ink)', padding: '3px 2px' }}
      />
    </div>
  );
}

// ── assetRef · chip + the 4b library drawer ─────────────────────────────────

function AssetRefControl({ name, value, types, onChange }: { name: string; value: string | undefined; types: ContentTypeDef[]; onChange: (v: unknown) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      {value ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <AssetStripe style={{ width: 56, height: 40, flex: '0 0 56px', padding: 0 }} />
          <Mono style={{ fontSize: 12, color: 'var(--ink)' }}>{value}</Mono>
          <Button size="sm" onClick={() => setOpen(true)}>Replace from library</Button>
          <Button size="sm" onClick={() => onChange(undefined)}>Remove</Button>
        </div>
      ) : (
        <Button size="sm" onClick={() => setOpen(true)}>+ Choose from library</Button>
      )}
      {open && (
        <AssetDrawer fieldName={name} current={value} types={types} onPick={(id) => { onChange(id); setOpen(false); }} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}

function AssetRefManyControl({ name, value, types, onChange }: { name: string; value: string[]; types: ContentTypeDef[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        {value.map((id) => (
          <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 9px', borderRadius: 'var(--r-pill)', border: '1px solid var(--border2)', background: 'var(--wash)', fontSize: 12 }}>
            <Mono style={{ fontSize: 11, color: 'var(--ink)' }}>{id}</Mono>
            <button onClick={() => onChange(value.filter((x) => x !== id))} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 0, font: 'inherit' }}>✕</button>
          </span>
        ))}
        <Button size="sm" onClick={() => setOpen(true)}>+ Add from library</Button>
      </div>
      {open && (
        <AssetDrawer
          fieldName={name}
          types={types}
          onPick={(id) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id])}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

// ── ref (single) · the 4c inline combobox ───────────────────────────────────

function SingleRefField({ f, types, value, onChange }: { f: FieldDef; types: ContentTypeDef[]; value: string | undefined; onChange: (v: unknown) => void }) {
  const [open, setOpen] = useState(false);
  const entries = useTargetEntries(f.target);
  const entry = value ? entries.find((e) => e.id === value) : undefined;
  return (
    <div>
      {value ? (
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '4px 12px 4px 5px', borderRadius: 'var(--r-pill)', border: '1px solid var(--border2)', background: 'var(--wash)', fontSize: 13 }}>
            <Avatar name={entry?.title ?? value} size={22} />
            {entry?.title ?? <Mono>{value.slice(0, 8)}…</Mono>}
          </span>
          {entry && <StatusBadge status={entry.status} />}
          <Button size="sm" onClick={() => setOpen(!open)}>Change</Button>
          <Button size="sm" onClick={() => onChange(undefined)}>✕</Button>
        </div>
      ) : (
        <Button size="sm" onClick={() => setOpen(!open)}>+ link</Button>
      )}
      {open && (
        <RefCombobox
          target={f.target ?? ''}
          targetDef={types.find((t) => t.key === f.target)}
          onPick={(id) => { onChange(id); setOpen(false); }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

// ── refMany · chips + the 4a modal picker ───────────────────────────────────

function ManyRefField({ f, def, types, fieldName, value, onChange }: {
  f: FieldDef;
  def: ContentTypeDef;
  types: ContentTypeDef[];
  fieldName: string;
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const entries = useTargetEntries(f.target);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const draft = value.map((id) => byId.get(id)).find((e) => e && e.status !== 'published' && e.status !== 'archived');
  const broken = value.map((id) => byId.get(id)).find((e) => e && e.status === 'archived');
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        <RefChipRow ids={value} byId={byId} onChange={onChange} />
        <Button size="sm" onClick={() => setOpen(true)}>+ Add {types.find((t) => t.key === f.target)?.title.toLowerCase() ?? 'link'}</Button>
      </div>
      {draft && (
        <div style={{ marginTop: 6, fontSize: 11.5, color: 'var(--st-review-fg)' }}>
          ⚠ “{draft.title}” is a draft — it won't resolve at delivery until published.
        </div>
      )}
      {broken && (
        <div style={{ marginTop: 6, fontSize: 11.5, color: 'var(--st-danger-fg)' }}>
          ⛓ “{broken.title}” is archived — the delivered reference would be broken.
        </div>
      )}
      {open && (
        <RefModalPicker
          fieldName={fieldName}
          ownerTitle={def.title}
          target={f.target ?? ''}
          targetDef={types.find((t) => t.key === f.target)}
          selected={value}
          onDone={(ids) => { onChange(ids); setOpen(false); }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
