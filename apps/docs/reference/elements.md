# @substrat-run/elements

Web components for a vertical's screens: a table of one paged read, an account menu and an
avatar. They are [Lit](https://lit.dev) elements on [Web Awesome](https://webawesome.com)'s
free core, styled only through its `--wa-*` tokens, so they follow whatever theme the page sets.
Web components work in React, Vue, Svelte or a plain HTML page, so a vertical's app does not
have to be written in any one framework to use them.

```sh
npm install @substrat-run/elements
```

```ts
import '@substrat-run/elements';
import '@substrat-run/elements/themes/base.css';
```

The package is still `0.x`: a minor release may change an element's attributes or slots.

## `<sub-user-menu>`

The account menu in a vertical's header. It shows who is signed in, opens a menu with your own
items, then "Switch user" and "Sign out".

```html
<sub-user-menu show="name">
  <wa-dropdown-item href="#/settings">Settings</wa-dropdown-item>
</sub-user-menu>
```

- `show` is `avatar` (the default, for a top-right corner), `name` or `email`.
- It reads `/api/me`, the answer vertical-auth's `mountSession` gives (`{ principal, display,
  email }`), and signs in and out through `/api/auth/login` and `/api/auth/logout`. Each URL is
  an attribute (`session-url`, `login-url`, `logout-url`) for an app with other routes. An app
  that already knows who is signed in sets the `session` property instead, and nothing is fetched.
- Signed out, it shows a "Sign in" button. Before the first read it shows an empty circle, never
  "Sign in".
- Every built-in part is a slot with a default: `trigger`, `header`, `teams`, `switch-user`,
  `sign-out` and `signed-out`. `account-url` adds "Manage account"; `hide-switch-user` drops
  "Switch user".
- `sub-sign-out` and `sub-switch-user` are cancelable: `preventDefault()` keeps the navigation
  from happening, so an app can confirm first or sign out its own way.

## `<sub-avatar>`

The same identity without the menu: the picture, or initials (by grapheme, so `María José
García` is MG) on a colour that follows the principal. `show="name"` or `show="email"` puts the
text beside it. It reads the same session as the menu, or draws the `session` property.

## `<sub-entity-table>`

The rows of one paged read: its views, its sort, its filters and search, a selection, and the
actions a row allows. Sorting, filtering and paging all happen on the server. The table owns a
query and hands it to your read, so it never sorts or filters the rows it happens to have loaded.

```ts
table.source = {
  read: ({ sort, order, limit, view }) =>
    api.myLists({ ...(sort ? { sort } : {}), order, ...(limit ? { limit } : {}), ...(view === 'archived' ? { view } : {}) }),
  follow: (next) => api.follow(next),
  search: (q) => api.searchLists({ q }), // optional: the entity's search read, ranked and capped
  searchViews: ['active'], // optional: the index leaves archived rows out, so search them nowhere
};
table.filters = [{ key: 'status', label: 'Status', options: [{ value: 'open', label: 'Open' }] }];
table.columns = [
  { key: 'name', label: 'List', sort: 'name', href: (l) => `#/list/${l.id}` },
  { key: 'created_at', label: 'Created', kind: 'relative', sort: 'created_at', priority: 2 },
];
table.views = [{ id: 'active', label: 'Active' }, { id: 'archived', label: 'Archived' }];
table.actions = [{ id: 'archive', label: 'Archive', views: ['active'], bulk: true, run: (l) => api.archiveList({ listId: l.id }) }];
```

- **Sort.** A column with `sort` gets a header button that cycles through ascending, descending
  and the read's own order. The generated client types `sort` as the columns the model declares
  `sortable`, so a column that has no index behind it won't compile.
- **Paging.** By default the footer shows "21–40 of 132", a rows-per-page picker (`page-size`,
  default 25; the `pageSizes` property holds the choices) and Previous / Next. The page size
  reaches your read as the query's `limit`. Next follows the `next` link the server handed out;
  Previous re-reads the page through the link that led to it, so the walk stays a keyset walk.
  There are no page numbers, because a keyset walk can't jump to page 7, and faking it would mean
  an offset that drops and repeats rows while someone writes. "of 132" needs
  `paged: { total: true }`. `paging="more"` swaps the pager for a single "Load more" that appends.
- **Search** (`source.search`) replaces the page with a ranked result, and the footer says so when
  the read was capped. A term shorter than two characters reads nothing. `searchViews` lists the
  views the search covers; in any other view there's no search box. While a search is showing,
  the filters are disabled, because a ranked search isn't filtered.
- **Filters** (`filters`: `{ key, label, options }`) are equality filters on the read's declared
  `filterable` fields. Each one shows its name beside its value ("Status Open"), and its value
  reaches your read as `query.filters[key]`. When a search or a filter returns nothing, the table says "Nothing matches"
  and offers Clear. That's a different message from "Nothing here".
- **Selection.** `selectable` adds checkboxes. Actions marked `bulk` run once per selected row,
  then the table reads once and reports what didn't happen ("2 of 3 done; 1 not allowed").
- **Refusals.** A 403 on the read shows a wall, never an empty list. A refused action keeps the
  rows on screen. A 409 or 404 on an action reads the view again.
- **Cells.** `kind` draws the value: `text`, `number`, `money` (a decimal string, never a float),
  `date`, `datetime`, `relative`, `badge` (with `tones`), `boolean` or `code`. `render(row)` returns a
  Lit template. `mount(cell, row)` hands you a light-DOM element for React, Vue or plain DOM, and
  your page's CSS applies inside it. It can return `{ update, unmount }`.
- **Narrow screens.** Columns with `priority` 3, then 2, are dropped while the table is wider than
  its frame.
- **Styling** goes from the outside in. First the theme's `--wa-*` tokens. Then `--sub-table-*`:
  `row-height`, `cell-padding-inline`, `cell-padding-block`, `header-background`, `row-hover`,
  `row-selected` and `max-height` (setting a max height makes the header stick). Then
  `density="compact"`. Last, `::part()`: `frame`, `toolbar`, `bulk-bar`, `table`, `header-cell`,
  `row` (plus `selected`), `cell`, `footer` and `empty`.
- The `empty` slot replaces the empty text, for example with a "Create" button.
- **Events.** `sub-query-change` fires with `{ query }` whenever the person changes the view,
  sort, filters or search, so a screen can keep the query in its URL and hand it back through the
  `query` property. `sub-action-done` fires with `{ action, rows }` after an action succeeds.

`EntityTableModel` is everything here except the drawing, with no DOM in it.

## The session read

`sessionAt(url)` returns the one `SessionStore` per URL that every element on the page shares,
so the page reads `/api/me` once. It reads again when the tab comes back into view, and a refresh
that fails keeps the last answer: going offline does not look like signing out. Subscribe to it
for your own sign-in gate, so it and the header agree.

## Themes

`themes/base.css` is Web Awesome's default theme. `themes/ledger.css` (dense, flat, cool) and
`themes/atelier.css` (warm, serif headings, roomy) are classes over it: put `sub-theme-ledger` on
`<html>`, and `wa-dark` for dark mode. A theme is token values only, so it never reaches into a
component.

## JSX types

`import type {} from '@substrat-run/elements/jsx'` types every `wa-*` element for a React or
Preact app. Declare the `sub-*` elements you use in your own `JSX.IntrinsicElements`.
