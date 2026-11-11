# @substrat-run/elements

Web components for a vertical's screens: a table of one paged read, an account menu, an avatar,
a conversation with an assistant, and a kanban board. They are [Lit](https://lit.dev) elements on [Web Awesome](https://webawesome.com)'s
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

This page is the reference. [Building screens](/elements/) is where to start, with
[framework use](/elements/frameworks), [theming](/elements/theming) and
[Web Awesome's controls](/elements/web-awesome).

## `<sub-user-menu>`

<ElementDemo name="user-menu" />

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
  From React, also set `session-url=""`: React sets a property only after the element is connected.
- Signed out, it shows a "Sign in" button. Before the first read it shows an empty circle, never
  "Sign in".
- Every built-in part is a slot with a default: `trigger`, `header`, `teams`, `switch-user`,
  `sign-out` and `signed-out`. `account-url` adds "Manage account"; `hide-switch-user` drops
  "Switch user".
- `sub-sign-out` and `sub-switch-user` are cancelable: `preventDefault()` keeps the navigation
  from happening, so an app can confirm first or sign out its own way.

## `<sub-avatar>`

<ElementDemo name="avatar" />

The same identity without the menu: the picture, or initials (by grapheme, so `María José
García` is MG) on a colour that follows the principal. `show="name"` or `show="email"` puts the
text beside it. It reads the same session as the menu, or draws the `session` property.

## `<sub-entity-table>`

<ElementDemo name="entity-table" />

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
- **Column width.** `width` takes a CSS width, for a column narrower than its share of the row.
- **Row click.** `row-click` makes a whole row clickable: a click anywhere but a control in the row
  fires `sub-row-click` with `{ row }`. It's a pointer shortcut, so what it opens should also be
  reachable through a link or a button in the row.
- **Row detail.** `detail(cell, row)` draws below a row, across the whole table, the way `mount`
  draws a cell. `expanded` is the key of the open row, or null. The table never opens one itself,
  so a screen keeps that state and decides what opens it.
- **Selection the screen owns (opt-in).** `selection` is the selected row keys, and a screen can
  read or set it at any time. `sub-selection-change` fires with `{ keys, rows, parents }` when the
  person or a re-read changes it, not when the screen set it. `row-select` makes the row itself
  select: a click selects that row alone, cmd/ctrl-click toggles it, shift-click extends from
  the last anchor, cmd/ctrl+A selects the rows loaded now, and Escape clears. Rows that load
  after a cmd/ctrl+A are not added to it.
- **What happens to a selection (opt-in).** Under `row-select`, or once a screen sets
  `selection`, a selection survives a page turn and a shift-click ranges over the pages walked so
  far. A row a re-read no longer returns leaves it. A new sort, filter, search or page size keeps
  only the selected rows its first read still has, and a new view clears it. A `selectable` table
  with neither keeps its original rule: the selection is the rows on screen.
- **Opening a row (opt-in).** `row-open` fires `sub-row-open` with `{ row }` on a double-click or
  Enter. With `row-click` as well, `sub-row-click` waits `doubleClickMs` (300) and does not fire
  for a double-click, so a single click can preview and a double-click can open. A double-click
  slower than that window reports both.
- **Keyboard (opt-in).** Any of `row-select`, `row-open`, `row-draggable` or `childrenOf` makes the
  table an ARIA grid with one focusable row. Up and Down move, Home and End jump, Shift+Up and
  Shift+Down extend the selection, and Space toggles it. Controls inside a row stay in the Tab order.
- **Loading on scroll (opt-in).** `paging="scroll"` loads the next page as the end of the list comes
  into view, with no total needed. It keeps a real "Load more" for a keyboard or screen reader, and
  Down on the last row loads too. A re-read keeps every page already loaded.
- **Row action icons.** A `RowAction` takes `icon`, a Web Awesome icon name or `{ src }` for your own
  SVG, drawn with `label` as its accessible name and tooltip. `menu: true` puts it in the "More"
  menu at the end of the row. Once any action says so, the others all stay on the row.
- **Right-click.** `sub-row-contextmenu` fires with `{ row, x, y, originalEvent }`. Call
  `preventDefault()` on it to keep the browser's own menu away and draw yours. Under `row-select`, a
  right-click on an unselected row selects it first.
- **Drag and drop (opt-in).** `row-draggable`, narrowed by `canDrag(row)`, makes rows draggable.
  `sub-row-dragstart` carries `{ row, rows, dataTransfer, originalEvent }`, where `rows` is the whole
  selection if the row is part of it. Set `dataTransfer` on it, or call `preventDefault()` to refuse.
  `canDrop(row, dragged)` says which rows take a drop. Without it no row does, and a dragged row
  never takes itself. It runs on every pointer move, so keep it cheap. A hovered target has the
  `drop-target` part, and `sub-row-drop` fires with `{ target, dragged, dataTransfer, originalEvent }`.
  The preview says how many are moving; `dragLabel(rows)` words it. On touch a long press
  (`longPressMs`, 500) starts the drag with `dataTransfer` null, and a finger that moves first scrolls.
  What a drop means is up to the screen.
- **Nested rows (opt-in).** `childrenOf(row)` returns a read in the same shape as `source`, made
  with the table's query when the row first opens, so each level sorts on its own. `canExpand(row)`
  says which rows can open, and `rowRank(row)` keeps some first within a level (lower first, such as
  folders before files). `open` is the open row keys, and `sub-row-toggle` fires with
  `{ row, key, open, keys }`. Right opens a row or moves to its first child; Left closes it or moves
  to its parent. Row keys must be unique across every level. Use `paging="scroll"` for the top
  level. Each open row gets its own "Load more" line. A search is a flat list of matches, with no
  levels. `reload()` reads every open level again, and `reload(key)` reads one. A failed or refused
  child read shows inside its row. Selecting a parent does not select its children: the selection is
  exactly what was picked, `parents` on the event says what is under what, and `topmost: true` on a
  bulk action skips a row whose parent is selected too.
- **Narrow screens.** Columns with `priority` 3, then 2, are dropped while the table is wider than
  its frame.
- **Styling** goes from the outside in. First the theme's `--wa-*` tokens. Then `--sub-table-*`:
  `row-height`, `cell-padding-inline`, `cell-padding-block`, `header-background`, `row-hover`,
  `row-selected`, `indent` (one level of nesting) and `max-height` (setting a max height makes the header stick). Then
  `density="compact"`. Last, `::part()`: `frame`, `toolbar`, `bulk-bar`, `table`, `header-cell`,
  `row` (plus `selected` and `drop-target`), `cell`, `detail`, `footer` and `empty`.
- The `empty` slot replaces the empty text, for example with a "Create" button.
- **Events.** `sub-query-change` fires with `{ query }` whenever the person changes the view,
  sort, filters or search, so a screen can keep the query in its URL and hand it back through the
  `query` property. `sub-action-done` fires with `{ action, rows }` after an action succeeds.
- **Choosing columns (opt-in).** `column-picker` adds a Columns button to the toolbar: a
  checkbox per column to show or hide it, and a drag handle plus Move up / Move down buttons to
  reorder it, so a keyboard or a screen reader can do anything a drag can. Reset to default
  goes back to the declared columns. The first column names the row and is always shown. The
  choice is a `layout` (`{ order, hidden }` by column key), kept apart from the query because it
  changes nothing the server is asked. `layout-key` keeps it in this browser. A screen that
  would rather keep it on the account listens for `sub-layout-change` and hands it back through
  `layout`. A column the table drops for lack of room is listed as "Hidden while narrow", so
  it does not seem to have vanished. Without `column-picker` the columns are exactly the ones given.
- **The query in the URL.** The table never writes to the URL itself, because the page owns
  its routing and may show two tables. `queryToParams(query, spec)` and
  `queryFromParams(params, spec)` give every app the same parameters
  (`?view=archived&sort=name&order=desc&done=1&q=milk`). `spec` lists the views, sorts, filter
  values and page sizes a link may name, and anything else is dropped, so a stale link shows
  the defaults instead of a refused read. Values equal to `spec.defaults` are left out, and
  `prefix` keeps two tables apart. The page itself is not written: a cursor answers one query
  at one moment, so a link or a reload starts at the first page. `demos/todo/app/src/elements.tsx`
  wires it with `replaceState`, so Back leaves the screen instead of stepping through filters.

`EntityTableModel` is everything here except the drawing, with no DOM in it.

## `<sub-kanban>`

<ElementDemo name="kanban" />

Cards in columns, where a column is a state and moving a card changes it. Hand it the columns
and the cards; the board shows them, and the moves made on it since.

```ts
import '@substrat-run/elements/kanban';

board.columns = [
  { key: 'todo', label: 'To do' },
  { key: 'doing', label: 'In progress', limit: 3 },
  { key: 'review', label: 'Review', limit: 2, strict: true },
  { key: 'done', label: 'Done' },
];
board.cards = tickets; // each with `id` and `status`, or set `keyOf` / `columnOf`
board.canDrop = (ticket, from, to) => TRANSITIONS[from].includes(to);
board.move = (m) => api.moveTicket({ ticketId: m.key, status: m.to, after: m.after, before: m.before });
```

- **Drag.** The card lifts out tilted (`--sub-kanban-tilt`, 3deg) and sways a little with the
  pointer. A gap opens where it will land and the other cards slide aside. Near an edge the
  board and the column scroll. On touch, hold the card for a moment before dragging, so a
  swipe still scrolls. Escape puts the card back.
- **Rules.** A column `canDrop` refuses is dimmed while a card is held, and says so when the
  card is over it. A reorder within a column is never refused. `limit` shows "2 / 3" in the
  header, warning at the limit and over it; `strict` also refuses the card that would take the
  column over.
- **Keyboard.** Space picks a card up. Arrow keys move it, skipping columns that refuse it, and
  Home / End take it to the top or bottom. Space or Enter drops it, Escape cancels. When no card
  is held, arrow keys move focus between cards. A screen reader hears every step.
- **Saving.** `move(m)` is called after the board already shows the move. While it is pending
  the card is marked busy; if it rejects, the card goes back and `sub-move-failed` fires.
  `sub-card-move` fires first and can be cancelled. `after` / `before` name the card's new
  neighbours, for a rank between them.
- **Without a drag.** `moveTo(key, column, index?)` makes the same move from a "Move to…" menu
  or a command palette.
- **Drawing cards.** `renderCard(card)` (Lit) or `mount(el, card)` (React, Vue), as a table
  cell does. A click or Enter on a card fires `sub-card-open`.
- **Adding cards.** `addable` puts "Add a card" under each column. It opens a field: Enter
  fires `sub-card-add` `{ column, title }` and keeps the field open for the next one, Escape
  closes it. The board makes no card itself — the screen creates it and hands it back in
  `cards`, as the demo above does in memory.
- `prefers-reduced-motion` turns off the tilt, the sliding and the settle.

## `<sub-assistant>`

<ElementDemo name="assistant" />

A conversation with an assistant: the transcript and the box to type in, and nothing around them.
It has no popup, modal or sidebar mode. It fills the box you give it, so give it a height, and put
it in whatever container the screen wants.

Your app creates the model and keeps it. Closing a dialog then keeps the conversation, and a new
model is a new conversation.

```ts
import '@substrat-run/elements/assistant';
import { AssistantModel } from '@substrat-run/elements/assistant-model';

const model = new AssistantModel({
  source: {
    async *send({ text, history }) {
      const { answer } = await api.ask({ messages: [...history, { role: 'user', text }] });
      yield { t: 'text-delta', pid: 'answer', delta: answer };
      yield { t: 'turn-finish', reason: 'done' };
    },
  },
});

document.querySelector('sub-assistant').model = model;
```

A source is one method that yields the events of `@substrat-run/contracts/assistant-stream`. A
plain request and response is the short generator above, and a streaming backend is another source
for the same model. If your source receives events over the wire, read them with
`readAssistantStreamEvent` so that a newer server cannot break an older page. Add `cancel()` to
offer a Stop button; without it, none is drawn.

| | |
|---|---|
| Properties | `model`; `labels`, a partial `AssistantLabels` over the English defaults |
| Attributes | `label` (the transcript's accessible name), `placeholder`, `max-length`, `heading-level`, `hide-composer` |
| Slot | `empty`, shown before the first question |
| Event | `sub-assistant-source`, with `{ citation, turn }`, when a source is clicked |
| Method | `focus()`: the input, or the transcript under `hide-composer` |

Answers are plain text, and the model's output is never treated as markup.

**Your own input.** Under `hide-composer` the element draws no box, and your input calls
`model.send(text)`. It returns `false` when there is nothing to send or an answer is still coming,
so you know to keep what was typed.

**Tool calls and notes.** Tool events are drawn as one quiet line, such as "Used list findings".
To say it in your own words, yield `{ t: 'host-event', kind: 'read', text: 'Read 3 customers' }`
instead. The same event records something your app did because of the answer, like "Updated the
canvas".

**Sources.** Yield `{ t: 'source', sid, title, ref }` and the element draws a button, and tells you
through `sub-assistant-source`; `ref` is your own handle on the record. With an `http(s)` `url` it
draws a link instead, and `preventDefault()` on the event keeps it from opening. Take `url` from
your server, never from the model's text.

**Words.** `labels` replaces any string the element says, including what a screen reader hears:

```ts
element.labels = { retry: 'Försök igen', working: 'Arbetar…' };
```

**Keys.** The element listens to nothing above itself. Enter on one of its own buttons is handled
there and marked with `preventDefault()`, so a command palette listening at `window` should start
with `if (event.defaultPrevented) return;`. Don't use Tab to switch a palette's modes once there is
a conversation, or keyboard users can't reach Retry or a source.

### Putting it somewhere

```html
<!-- A ⌘K modal. Your code binds the shortcut. -->
<wa-dialog label="Ask"><sub-assistant style="height: 28rem"></sub-assistant></wa-dialog>

<!-- A sidebar. `wa-split-panel` or `wa-page` docks it instead. -->
<wa-drawer label="Ask" placement="end"><sub-assistant style="height: 100%"></sub-assistant></wa-drawer>

<!-- A chat popup. Your code adds the launcher and any unread badge. -->
<div style="position: fixed; inset: auto 1rem 1rem auto; width: 24rem; height: 32rem">
  <sub-assistant style="height: 100%"></sub-assistant>
</div>
```

### Without Web Awesome

The element loads no Web Awesome component, only reads its tokens, and each token has a readable
fallback. An app on another stack maps its own colours and is done:

```css
sub-assistant {
  --wa-color-text-normal: hsl(var(--foreground));
  --wa-color-text-quiet: hsl(var(--muted-foreground));
  --wa-color-neutral-fill-quiet: hsl(var(--muted));
  --wa-color-surface-border: hsl(var(--border));
  --wa-color-surface-default: hsl(var(--background));
  --wa-form-control-border-color: hsl(var(--border));
  --wa-color-brand-fill-loud: hsl(var(--primary));
  --wa-color-brand-on-loud: hsl(var(--primary-foreground));
  --wa-color-brand-fill-quiet: hsl(var(--accent));
  --wa-color-brand-on-quiet: hsl(var(--primary));
  --wa-color-danger-on-quiet: hsl(var(--destructive));
  --wa-border-radius-m: var(--radius);
  --wa-font-family-body: inherit;
}
```

Beyond the tokens, `--sub-assistant-gap` sets the spacing and `::part()` reaches `transcript`,
`turn`, `question`, `ai-marker`, `answer`, `trace`, `working`, `sources`, `source`, `provenance`,
`note`, `failure`, `retry`, `jump`, `composer`, `input`, `send` and `stop`.

## The session read

`sessionAt(url)` returns the one `SessionStore` per URL that every element on the page shares,
so the page reads `/api/me` once. It reads again when the tab comes back into view, and a refresh
that fails keeps the last answer: going offline does not look like signing out. Subscribe to it
for your own sign-in gate, so it and the header agree.

## Importing one element

`import '@substrat-run/elements'` registers every element, and your bundler cannot remove the ones
you do not use. If your app needs only some of them, import those instead:

```ts
import '@substrat-run/elements/user-menu';
```

| Subpath | What it brings |
|---|---|
| `/assistant` | `<sub-assistant>` |
| `/assistant-model` | `AssistantModel` and its helpers, with no element |
| `/avatar` | `<sub-avatar>` |
| `/user-menu` | `<sub-user-menu>`, and the `<sub-avatar>` it draws |
| `/entity-table` | `<sub-entity-table>` |
| `/entity-table-model` | `EntityTableModel` and the table's helpers, with no element |
| `/session` | `sessionAt` and the session helpers, with no element |

Each of these exports what its own module declares. `import type` from the package root is always
free, because a type never reaches the bundle, so `import type { Session } from
'@substrat-run/elements'` is fine beside any of them.

## Themes

`themes/base.css` is Web Awesome's default theme. `themes/ledger.css` (dense, flat, cool) and
`themes/atelier.css` (warm, serif headings, roomy) are classes over it: put `sub-theme-ledger` on
`<html>`, and `wa-dark` for dark mode. A theme is token values only, so it never reaches into a
component.

## JSX types

`import type {} from '@substrat-run/elements/jsx'` types every `wa-*` element for a React or
Preact app. Declare the `sub-*` elements you use in your own `JSX.IntrinsicElements`.
