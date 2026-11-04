/**
 * The `@substrat-run/elements` prototype, dogfooded: your lists as a `<sub-entity-table>`,
 * and a switcher between Web Awesome's default theme and two Substrat ones.
 *
 * React 18 passes a custom element's props as attributes, so the table's object and
 * function properties (`source`, `columns`, `actions`) are set through a ref. React 19
 * sets them as properties, and this file would shrink to the JSX.
 */
import { useEffect, useRef, useState } from 'react';
import type { Column, RowAction, SubEntityTable } from '@substrat-run/elements';
import '@substrat-run/elements';
import '@substrat-run/elements/themes/base.css';
import '@substrat-run/elements/themes/ledger.css';
import '@substrat-run/elements/themes/atelier.css';
import { api, type List } from './api.js';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'sub-entity-table': React.DetailedHTMLProps<React.HTMLAttributes<SubEntityTable<List>>, SubEntityTable<List>> & {
        label?: string;
        empty?: string;
        'forbidden-text'?: string;
      };
    }
  }
}

const created = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

const COLUMNS: Column<List>[] = [
  { key: 'name', label: 'List', value: (l) => l.name, href: (l) => `#/list/${l.id}` },
  { key: 'created', label: 'Created', value: (l) => created.format(new Date(l.created_at)), priority: 2 },
  { key: 'id', label: 'Id', value: (l) => l.id, priority: 3 },
];

const ACTIONS: RowAction<List>[] = [
  { id: 'archive', label: 'Archive', run: (l) => api.archiveList({ listId: l.id }) },
  { id: 'trash', label: 'Trash', tone: 'danger', run: (l) => api.trashList({ listId: l.id }) },
];

export function ListsTable() {
  const ref = useRef<SubEntityTable<List>>(null);
  useEffect(() => {
    const table = ref.current;
    if (!table) return;
    table.columns = COLUMNS;
    table.actions = ACTIONS;
    table.source = { first: () => api.myLists({}), follow: (next) => api.follow<List>(next) };
  }, []);
  return (
    <>
      <h2>Your lists, as a table</h2>
      <p className="sub">
        The same read as the Active view, drawn by <code>&lt;sub-entity-table&gt;</code>. When the table runs out of room, the
        Id column goes first, then Created.
      </p>
      <sub-entity-table
        ref={ref}
        label="Your lists"
        empty="Nothing yet. Create a list, or ask someone to share one with you."
        forbidden-text="You may not see these lists."
      />
    </>
  );
}

const THEMES = [
  { id: 'default', label: 'Web Awesome', className: 'wa-theme-default' },
  { id: 'ledger', label: 'Ledger', className: 'sub-theme-ledger' },
  { id: 'atelier', label: 'Atelier', className: 'sub-theme-atelier' },
] as const;
type ThemeId = (typeof THEMES)[number]['id'];

const stored = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

export function ThemePicker() {
  const [theme, setTheme] = useState<ThemeId>(() => (THEMES.find((t) => t.id === stored('todo.theme'))?.id ?? 'ledger'));
  const [dark, setDark] = useState(() => stored('todo.dark') === '1');

  useEffect(() => {
    const root = document.documentElement.classList;
    for (const t of THEMES) root.toggle(t.className, t.id === theme);
    root.toggle('wa-dark', dark);
    root.toggle('wa-light', !dark);
    try {
      localStorage.setItem('todo.theme', theme);
      localStorage.setItem('todo.dark', dark ? '1' : '0');
    } catch {
      // A private window: the choice lasts for this page only.
    }
  }, [theme, dark]);

  return (
    <span className="themes">
      <select aria-label="Theme" value={theme} onChange={(e) => setTheme(e.target.value as ThemeId)}>
        {THEMES.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </select>
      <label>
        <input type="checkbox" checked={dark} onChange={(e) => setDark(e.target.checked)} /> Dark
      </label>
    </span>
  );
}
