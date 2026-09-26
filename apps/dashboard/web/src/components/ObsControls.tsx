import type { ReactNode } from 'react';
import { Select } from '@substrat-run/ui';
import type { AppRow } from '../lib/api';

/**
 * The pieces every Observability child's header shares (#1767). Each child draws its own
 * header now — Pulse a heading and a range, Logs a query bar, Processes only its heading —
 * so what is shared is the parts, not a row.
 */

/** The page heading and the one line under it. */
export function PageHead({ title, sub }: { title: string; sub: ReactNode }) {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <h1 style={{ margin: 0, fontSize: 22, lineHeight: '29px', fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>{title}</h1>
      <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>{sub}</div>
    </div>
  );
}

/**
 * The app filter, compact. It stays on every child: one-app mode is where Pulse draws a
 * deploy strip and schedules, and where Logs and Processes can answer at all.
 */
export function AppFilter({ apps, value, onChange }: { apps: AppRow[]; value: string | null; onChange: (scopeId: string | null) => void }) {
  return (
    <Select
      ariaLabel="App"
      size="sm"
      options={[{ value: '', label: 'All apps' }, ...apps.map((a) => ({ value: a.app_scope_id, label: a.name }))]}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      style={{ width: 160 }}
    />
  );
}
