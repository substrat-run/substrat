/**
 * The `@substrat-run/elements` prototype, dogfooded: the controls every screen uses
 * (`/controls`, Web Awesome's free core), the themes, and your lists as a
 * `<sub-entity-table>`. Choosing a theme is `src/settings.tsx`.
 *
 * React 18 sets a custom element's props as ATTRIBUTES, so a boolean is written
 * `disabled={x || undefined}` — `false` would become the attribute "false", which is
 * present and so true. A class is `class`, not `className`, which React 18 writes as a
 * literal `classname` attribute on a custom element. Events arrive through
 * `onInput`/`onClick`, which bubble out of the shadow root. React 19 removes all three.
 *
 * React 18 passes a custom element's props as attributes, so the table's object and
 * function properties (`source`, `columns`, `actions`) are set through a ref. React 19
 * sets them as properties, and this file would shrink to the JSX.
 */
import { useEffect, useRef, useState } from 'react';
import { sessionAt, type Column, type RowAction, type SessionState, type SubEntityTable, type SubUserMenu } from '@substrat-run/elements';
import type {} from '@substrat-run/elements/jsx';
import '@substrat-run/elements';
import '@substrat-run/elements/controls';
import '@substrat-run/elements/themes/base.css';
import '@substrat-run/elements/themes/native.css';
import '@substrat-run/elements/themes/ledger.css';
import '@substrat-run/elements/themes/atelier.css';
import { api, type List } from './api.js';
import './appearance.js';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'sub-entity-table': React.DetailedHTMLProps<React.HTMLAttributes<SubEntityTable<List>>, SubEntityTable<List>> & {
        label?: string;
        empty?: string;
        'forbidden-text'?: string;
      };
      'sub-user-menu': React.DetailedHTMLProps<React.HTMLAttributes<SubUserMenu>, SubUserMenu> & {
        show?: 'avatar' | 'name' | 'email';
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

/**
 * The session `<sub-user-menu>` reads, for the screens that also need it — the same
 * shared read, so the page asks `/api/me` once.
 */
export function useSession(): SessionState {
  const store = sessionAt('/api/me');
  const [state, setState] = useState(store.state);
  useEffect(() => store.subscribe(setState), [store]);
  return state;
}

/**
 * The account menu, with Settings as this vertical's one item of its own. Switching
 * user and signing out are the element's: it knows the auth endpoints.
 */
export function AccountMenu() {
  return (
    <sub-user-menu show="name">
      <wa-dropdown-item href={SETTINGS_HREF}>Settings</wa-dropdown-item>
    </sub-user-menu>
  );
}

const SETTINGS_HREF = '#/settings';
