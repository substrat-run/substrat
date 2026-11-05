/**
 * The `@substrat-run/elements` prototype, dogfooded: the controls every screen uses
 * (`/controls`, Web Awesome's free core), the themes, and two `<sub-entity-table>`s —
 * your lists, and one list's items. Choosing a theme is `src/settings.tsx`.
 *
 * Nothing here filters, sorts or pages in the browser. The lists table hands each query to
 * `my-lists` / `trashed-lists`, whose `sort` the generated client types as the two columns
 * the model declares sortable; the items table hands a search term to `search-list-items`,
 * which is ranked and capped and says so.
 *
 * React 18 sets a custom element's props as ATTRIBUTES, so a boolean is written
 * `disabled={x || undefined}` — `false` would become the attribute "false", which is
 * present and so true. A class is `class`, not `className`, which React 18 writes as a
 * literal `classname` attribute on a custom element. Events arrive through
 * `onInput`/`onClick`, which bubble out of the shadow root. React 19 removes all three.
 *
 * React 18 passes a custom element's props as attributes, so the table's object and
 * function properties (`source`, `columns`, `actions`, `views`) are set through a ref. React
 * 19 sets them as properties, and this file would shrink to the JSX.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  sessionAt,
  type Column,
  type RowAction,
  type SessionState,
  type SubEntityTable,
  type SubUserMenu,
  type TableSource,
  type TableView,
} from '@substrat-run/elements';
import type {} from '@substrat-run/elements/jsx';
import '@substrat-run/elements';
import '@substrat-run/elements/controls';
import '@substrat-run/elements/themes/base.css';
import '@substrat-run/elements/themes/native.css';
import '@substrat-run/elements/themes/ledger.css';
import '@substrat-run/elements/themes/atelier.css';
import { api, type Item, type List } from './api.js';
import './appearance.js';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'sub-entity-table': React.DetailedHTMLProps<React.HTMLAttributes<SubEntityTable>, SubEntityTable> & {
        label?: string;
        empty?: string;
        'forbidden-text'?: string;
        'search-label'?: string;
        selectable?: boolean;
        density?: 'comfortable' | 'compact';
      };
      'sub-user-menu': React.DetailedHTMLProps<React.HTMLAttributes<SubUserMenu>, SubUserMenu> & {
        show?: 'avatar' | 'name' | 'email';
      };
    }
  }
}

/** What `my-lists` may be sorted by — the generated client's own union, not a copy of it. */
type ListSort = NonNullable<Parameters<typeof api.myLists>[0]['sort']>;

/**
 * A cell drawn by React, into the light-DOM element the table hands `mount`: the page's
 * stylesheet applies inside it, and a changed row re-renders the same root.
 */
export function reactCell<T>(draw: (row: T) => ReactNode): NonNullable<Column<T>['mount']> {
  return (cell, row) => {
    const root = createRoot(cell);
    root.render(draw(row));
    return { update: (next) => root.render(draw(next)), unmount: () => root.unmount() };
  };
}

/**
 * Set the table's properties once; React 18 cannot (see the header). Once, because the
 * table owns its query from then on, and a new `source` would start it over.
 */
function useTable<T, S extends string = string>(
  ref: React.RefObject<SubEntityTable>,
  props: { source: TableSource<T, S>; columns: Column<T, S>[]; actions?: RowAction<T>[]; views?: TableView[] },
) {
  useEffect(() => {
    const table = ref.current as SubEntityTable<T, S> | null;
    if (!table) return;
    table.columns = props.columns;
    table.actions = props.actions ?? [];
    table.views = props.views ?? [];
    table.source = props.source;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

const LIST_VIEWS: TableView[] = [
  { id: 'active', label: 'Active' },
  { id: 'archived', label: 'Archived' },
  { id: 'trash', label: 'Trash' },
];

/** Each view is its own read on the server, as on the Lists screen (#119). */
const LISTS: TableSource<List, ListSort> = {
  read: ({ view, sort, order }) => {
    const page = { ...(sort ? { sort } : {}), order };
    if (view === 'trash') return api.trashedLists(page);
    return api.myLists({ ...page, ...(view === 'archived' ? { view: 'archived' as const } : {}) });
  },
  follow: (next) => api.follow<List>(next),
};

const LIST_COLUMNS: Column<List, ListSort>[] = [
  // A binned list opens nowhere: what is in the bin is restored first, then read.
  { key: 'name', label: 'List', sort: 'name', href: (l, q) => (q.view === 'trash' ? null : `#/table/list/${l.id}`) },
  { key: 'created_at', label: 'Created', kind: 'relative', sort: 'created_at', priority: 2 },
  { key: 'id', label: 'Id', kind: 'code', priority: 3 },
];

const LIST_ACTIONS: RowAction<List>[] = [
  { id: 'archive', label: 'Archive', views: ['active'], bulk: true, run: (l) => api.archiveList({ listId: l.id }) },
  { id: 'unarchive', label: 'Unarchive', views: ['archived'], bulk: true, run: (l) => api.unarchiveList({ listId: l.id }) },
  { id: 'restore', label: 'Restore', views: ['trash'], bulk: true, run: (l) => api.restoreList({ listId: l.id }) },
  { id: 'trash', label: 'Trash', tone: 'danger', views: ['active', 'archived'], bulk: true, run: (l) => api.trashList({ listId: l.id }) },
  // Deliberately not a bulk action: "delete for good" is said about one list at a time.
  { id: 'delete', label: 'Delete for good', tone: 'danger', views: ['trash'], run: (l) => api.deleteList({ listId: l.id }) },
];

export function ListsTable() {
  const ref = useRef<SubEntityTable>(null);
  useTable(ref, { source: LISTS, columns: LIST_COLUMNS, actions: LIST_ACTIONS, views: LIST_VIEWS });
  return (
    <>
      <h2>Your lists, as a table</h2>
      <p className="sub">
        The same reads as the three views, drawn by <code>&lt;sub-entity-table&gt;</code>. Sorting asks the server, by the two
        columns the model declares sortable. Tick lists to archive, trash or restore several at once. When the table runs
        out of room, the Id column goes first, then Created.
      </p>
      <sub-entity-table
        ref={ref}
        label="Your lists"
        selectable
        empty="Nothing here yet. Create a list, or ask someone to share one with you."
        forbidden-text="You may not see these lists."
      />
    </>
  );
}

/** A list's items: a paged read with a total, its search read, and a React-drawn Done cell. */
export function ItemsTable({ listId }: { listId: string }) {
  const ref = useRef<SubEntityTable>(null);
  useTable<Item>(ref, {
    source: {
      read: () => api.listItems({ listId }),
      follow: (next) => api.follow<Item>(next),
      search: (q) => api.searchListItems({ listId, q }),
    },
    columns: [
      { key: 'text', label: 'Item' },
      {
        key: 'done',
        label: 'Done',
        // Drawn by React to show the seam: a framework component in a cell, styled by this
        // page's stylesheet, calling this vertical's own operation.
        mount: reactCell((item: Item) => (
          <DoneToggle item={item} onChanged={() => void ref.current?.reload()} />
        )),
      },
      { key: 'added_by', label: 'Added by', kind: 'code', priority: 3 },
      { key: 'created_at', label: 'Added', kind: 'relative', priority: 2 },
    ],
    actions: [{ id: 'delete', label: 'Delete', tone: 'danger', bulk: true, run: (i) => api.deleteItem({ itemId: i.id }) }],
  });
  return (
    <>
      <a className="back" href="#/table">
        ← your lists, as a table
      </a>
      <h2 style={{ marginTop: '.6rem' }}>Items, as a table</h2>
      <p className="sub">
        Search asks the list's text index rather than filtering what has loaded, so it finds an item on page nine. The
        Done column is a React component the table mounts into its cell.
      </p>
      <sub-entity-table
        ref={ref}
        label="Items"
        selectable
        density="compact"
        search-label="Search this list"
        empty="Nothing on this list yet."
        forbidden-text="You may not see this list."
      />
    </>
  );
}

function DoneToggle({ item, onChanged }: { item: Item; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const done = item.done === 1;
  return (
    <label className="done-toggle">
      <input
        type="checkbox"
        checked={done}
        disabled={busy}
        onChange={async () => {
          setBusy(true);
          try {
            await api.setItemDone({ itemId: item.id, done: !done });
            onChanged();
          } finally {
            setBusy(false);
          }
        }}
      />
      <span>{done ? 'Done' : 'Open'}</span>
    </label>
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
