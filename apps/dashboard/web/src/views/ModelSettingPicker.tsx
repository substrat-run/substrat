import type { ModelCatalogOption } from '../lib/api';

interface Props {
  value: string;
  catalog: readonly ModelCatalogOption[];
  onChange(value: string): void;
}

/** The one model-setting control shared by any vertical that declares kind: model. */
export function ModelSettingPicker({ value, catalog, onChange }: Props) {
  const active = catalog.filter((entry) => entry.status === 'active');
  const current = active.find((entry) => entry.id === value);
  const groups = new Map<string, ModelCatalogOption[]>();
  for (const entry of active) (groups.get(entry.servedBy) ?? groups.set(entry.servedBy, []).get(entry.servedBy)!).push(entry);

  return (
    <>
      <select
        aria-label="Model"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        style={{ width: '100%', maxWidth: 460, height: 34, padding: '0 11px', fontSize: 13,
          background: 'var(--surface-inset)', border: '1px solid var(--border-default)',
          borderRadius: 6, color: 'var(--text-primary)' }}
      >
        {!value && <option value="">Choose a model</option>}
        {value && !current && <option value={value}>Unlisted: {value}</option>}
        {[...groups.entries()].map(([servedBy, entries]) => (
          <optgroup key={servedBy} label={servedBy}>
            {entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          </optgroup>
        ))}
      </select>
      {current ? (
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 6 }}>
          {current.servedBy} · List price from ${current.inputPer1M} input / ${current.outputPer1M} output per 1M tokens
        </div>
      ) : value ? (
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 6 }}>
          Unlisted value already saved. Choose a listed model to replace it.
        </div>
      ) : null}
    </>
  );
}
