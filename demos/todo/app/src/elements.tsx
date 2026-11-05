/**
 * The `@substrat-run/elements` prototype, dogfooded: the controls every screen uses
 * (`/controls`, Web Awesome's free core), the themes, and two `<sub-entity-table>`s —
 * your lists, and one list's items. Choosing a theme is `src/settings.tsx`.
 *
 * Each table keeps its query in the URL, after the route (`#/table?view=archived&sort=name`):
 * read once when the table mounts, written back on every `sub-query-change` with
 * `replaceState`, so a reload or a shared link shows the same view, sort, filter and search,
 * and Back leaves the screen rather than stepping through filter changes. The page is not
 * kept — a cursor answers one query at one moment — so a link starts at the first page.
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
  queryFromParams,
  queryToParams,
  sessionAt,
  type Column,
  type QueryParams,
  type RowAction,
  type SessionState,
  type SubEntityTable,
  type SubUserMenu,
  type TableFilter,
  type TableQuery,
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
        paging?: 'pages' | 'more';
        'page-size'?: number;
        'column-picker'?: boolean;
        'layout-key'?: string;
      };
      'sub-user-menu': React.DetailedHTMLProps<React.HTMLAttributes<SubUserMenu>, SubUserMenu> & {
        show?: 'avatar' | 'name' | 'email';
      };
    }
  }
}

/** What each read may be sorted by — the generated client's own unions, not copies of them. */
type ListSort = NonNullable<Parameters<typeof api.myLists>[0]['sort']>;
type ItemSort = NonNullable<Parameters<typeof api.listItems>[0]['sort']>;

/**
 * A cell drawn by React, into the light-DOM element the table hands `mount`: the page's
 * stylesheet applies inside it, and a changed row re-renders the same root.
 */
export function reactCell<T>(draw: (row: T) => ReactNode): NonNullable<Column<T>['mount']> {
  return (cell, row) => {
    const root = createRoot(cell);
    root.render(draw(row));
    // Deferred: leaving the screen unmounts the table during React's own render, and a root
    // unmounted synchronously inside it is a race React warns about.
    return { update: (next) => root.render(draw(next)), unmount: () => queueMicrotask(() => root.unmount()) };
  };
}

/**
 * Set the table's properties once; React 18 cannot (see the header). Once, because the
 * table owns its query from then on, and a new `source` would start it over.
 */
function useTable<T, S extends string = string>(
  ref: React.RefObject<SubEntityTable>,
  props: {
    source: TableSource<T, S>;
    columns: Column<T, S>[];
    actions?: RowAction<T>[];
    views?: TableView[];
    filters?: TableFilter[];
    /** What the query may say in the URL; the views, sorts and filters are read off the rest. */
    params: Pick<QueryParams<S>, 'defaults' | 'limits'>;
  },
) {
  useEffect(() => {
    const table = ref.current as SubEntityTable<T, S> | null;
    if (!table) return;
    const spec: QueryParams<S> = {
      ...props.params,
      views: (props.views ?? []).map((v) => v.id),
      sorts: props.columns.flatMap((c) => (c.sort ? [c.sort] : [])),
      filters: Object.fromEntries((props.filters ?? []).map((f) => [f.key, f.options.map((o) => o.value)])),
    };
    table.columns = props.columns;
    table.actions = props.actions ?? [];
    table.views = props.views ?? [];
    table.filters = props.filters ?? [];
    table.query = queryFromParams(hashParams(), spec);
    table.source = props.source;
    const write = (e: Event) => {
      const params = queryToParams((e as CustomEvent<{ query: TableQuery<S> }>).detail.query, spec).toString();
      const route = window.location.hash.split('?')[0];
      history.replaceState(history.state, '', params ? `${route}?${params}` : route);
    };
    table.addEventListener('sub-query-change', write);
    return () => table.removeEventListener('sub-query-change', write);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** The parameters after the route in the hash: `#/table?sort=name` → `sort=name`. */
const hashParams = () => new URLSearchParams(window.location.hash.split('?')[1] ?? '');

/** The table's own rows-per-page choices, and the lists table's first one. */
const PAGE_SIZES = [10, 25, 50, 100];
const LISTS_PAGE = 10;

const LIST_VIEWS: TableView[] = [
  { id: 'active', label: 'Active' },
  { id: 'archived', label: 'Archived' },
  { id: 'trash', label: 'Trash' },
];

/** The query's page half, as the generated client's page parameters. */
const pageOf = <S extends string>({ sort, order, limit }: TableQuery<S>) => ({
  ...(sort ? { sort } : {}),
  order,
  ...(limit ? { limit } : {}),
});

/**
 * Each view is its own read on the server, as on the Lists screen (#119). Search is the
 * active lists only: the index leaves archived and binned lists out, so the box is not
 * offered over them rather than answering "no matches" for a list that is right there.
 */
const LISTS: TableSource<List, ListSort> = {
  read: (query) => {
    if (query.view === 'trash') return api.trashedLists(pageOf(query));
    return api.myLists({ ...pageOf(query), ...(query.view === 'archived' ? { view: 'archived' as const } : {}) });
  },
  follow: (next) => api.follow<List>(next),
  search: (q) => api.searchLists({ q }),
  searchViews: ['active'],
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
  useTable(ref, {
    source: LISTS,
    columns: LIST_COLUMNS,
    actions: LIST_ACTIONS,
    views: LIST_VIEWS,
    params: { defaults: { view: 'active', limit: LISTS_PAGE }, limits: PAGE_SIZES },
  });
  return (
    <>
      <h2>Your lists, as a table</h2>
      <p className="sub">
        The same reads as the three views, drawn by <code>&lt;sub-entity-table&gt;</code>. Sorting, paging and search all
        ask the server: the sort by the two columns the model declares sortable, the pages through the keyset walk, the
        search through the list-name index. Tick lists to archive, trash or restore several at once. When the table runs
        out of room, the Id column goes first, then Created. Columns shows, hides and reorders them, and this browser
        remembers what you chose.
      </p>
      <sub-entity-table
        ref={ref}
        label="Your lists"
        selectable
        column-picker
        layout-key="todo.lists"
        search-label="Find a list"
        page-size={LISTS_PAGE}
        empty="Nothing here yet. Create a list, or ask someone to share one with you."
        forbidden-text="You may not see these lists."
      />
    </>
  );
}

/** A list's items: a paged read with a total, its search read, and a React-drawn Done cell. */
export function ItemsTable({ listId }: { listId: string }) {
  const ref = useRef<SubEntityTable>(null);
  useTable<Item, ItemSort>(ref, {
    source: {
      // `done` is a declared filterable column, so it goes to the server as one, never to a
      // `.filter()` over the page that happened to load.
      read: (query) =>
        api.listItems({ listId, ...pageOf(query), ...(query.filters['done'] ? { done: Number(query.filters['done']) } : {}) }),
      follow: (next) => api.follow<Item>(next),
      search: (q) => api.searchListItems({ listId, q }),
    },
    filters: [{ key: 'done', label: 'Status', options: [{ value: '0', label: 'Open' }, { value: '1', label: 'Done' }] }],
    columns: [
      { key: 'text', label: 'Item', sort: 'text' },
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
      // Sorted by the id, which is a ULID and so the order they were added in.
      { key: 'created_at', label: 'Added', kind: 'relative', sort: 'id', priority: 2 },
    ],
    actions: [{ id: 'delete', label: 'Delete', tone: 'danger', bulk: true, run: (i) => api.deleteItem({ itemId: i.id }) }],
    params: { defaults: { limit: 25 }, limits: PAGE_SIZES },
  });
  return (
    <>
      <a className="back" href="#/table">
        ← your lists, as a table
      </a>
      <h2 style={{ marginTop: '.6rem' }}>Items, as a table</h2>
      <p className="sub">
        Search asks the list's text index and the Status filter asks the server, rather than either sifting what has
        loaded, so both find an item on page nine. The Done column is a React component the table mounts into its cell.
      </p>
      <sub-entity-table
        ref={ref}
        label="Items"
        selectable
        column-picker
        layout-key="todo.items"
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
