# 9. Screens

Every chapter so far has stopped at the API. This one is the other side of it: what a
person's browser talks to, and what the platform does and does not supply for drawing it.

The short version has not changed since the first edition. **Substrat has no opinion about
your UI.** A vertical's declared model is the contract, the platform serves it over HTTP, and
anything that speaks HTTP can be the front end: React, Vue, Svelte, plain HTML, a phone app.
Nothing in the kernel, the engines or `substrat push` knows which.

What has changed is that "no opinion about the UI" no longer means "nothing for the UI". The
platform now publishes a small set of web components for the parts of a business app's screens
that are hard and the same everywhere. It draws its own two consoles with them, which is what
keeps them honest. They are optional, one element at a time.

## What the browser talks to

A deployed vertical's worker serves three things to a browser, all from the same origin.

**The app's own files.** If the vertical has an `app/`, its build output is declared in
`substrat.runtimeNeeds.assets`, with the build command beside it. The platform serves those
bytes as static assets, verified by their content address. A vertical that has an `app/` and
does not declare it serves its API and answers 404 on `/`, with every local gate green, which is
why `substrat push` refuses the combination.

**The sign-in door.** Chapter 3 follows a request through `workerDoor`. From the browser's side
it is three routes: the login round-trip at `/api/auth/*`, `/api/me` to ask who is signed in, and
`/api/claim-owner` for the owner seat. `/api/me` answers with the person when the login is bound
to one. When it is bound to nobody, it answers `needs-setup` if the owner seat is still
unclaimed, and `401` if the seat is taken. A screen should tell those three apart: "set this
app up" is a different page from a sign-in button, and an app must not offer a sign-in that
would bind nobody.

**The declared operations**, mounted by `mountOperations` in three forms with no extra
declaration. They are served as REST routes with an `openapi.json`, as an MCP server at
`/api/mcp`, and as an API reference page at `/api/docs`. That page and its renderer are bundled
and self-hosted, and it reads the specification through the app's existing session.

## The generated client

The browser does not hand-write requests either. A vertical that names `substrat.client` in its
`package.json` gets `app/src/api.generated.ts`, generated from `spec/model.ts` and held to it by a
`--check` in CI. Everything in it is a fact the model already states: the entity interfaces, the
paths and methods, the request bodies, the walk along a paged read's `Link` header.

Two details matter for screens.

- **A paged read takes `limit`, `order` and `sort`, with `sort` typed to the read's sortable
  columns.** A sort on a column with no index behind it does not compile. That is what lets a
  table drive a real query instead of sorting the one page it already holds.
- **A failure that is not JSON is still an `ApiError`.** An HTML error page from a proxy used to
  surface as a `SyntaxError` out of `res.json()`. Now it carries a status like any other
  failure, and a problem document's `type` links to a page explaining its code (chapter 15).

What stays hand-written beside the client is only what the model does not declare: which person
a request is made as, and how your screens present an error.

## Why web components

Framework-free is the point, not a compromise. A vertical's screens may be React today and
something else next year, and a screen a model generates may be in whatever the model reached
for. A component that only one framework can host would make that choice for the vertical, and
the platform has no business making it.

So `@substrat-run/elements` is [Lit](https://lit.dev) on [Web Awesome](https://webawesome.com)'s
free core. The browser runs them, not your framework. Each framework only spells the three kinds
of input differently:

- **attributes**, strings and booleans: `selectable`, `page-size="50"`;
- **properties**, everything else: `columns`, `source`, `actions`, `query`;
- **events**, DOM events with a `detail`: `sub-query-change`, `sub-action-done`.

They are styled only through Web Awesome's `--wa-*` tokens. A theme is a list of values, and the
whole app follows it, in light and in dark, with no fork of the components. A team that already
has design tokens maps its own onto those.

**Import each element from its own subpath.** An element registers itself and imports its Web
Awesome components as a side effect, so a bundler cannot shake an unused one out of the package
root. Importing the avatar from the root shipped the entity table too, at 84 KB gzipped against
27 KB for the avatar alone. `import '@substrat-run/elements/user-menu'` brings the menu and the
avatar it draws, and nothing else.

## The hard parts, named

The elements exist for a specific list of problems. Each of them is easy to get mostly right
and wrong in a way that surfaces months later.

- **Telling states apart.** A `403` is a wall with an explanation, not an empty list. "No
  matches" is a different message from "nothing here". A refused action keeps its rows on screen
  rather than clearing them.
- **Reading a list properly.** Sorting, filtering, search and paging happen on the server, and
  paging stays a keyset walk, so rows neither drop nor repeat while someone else writes.
  Chapter 4's opaque cursor is the reason that works.
- **Stale views.** When an action finds its row changed or gone (`409` or `404`), the table reads
  the view again instead of showing what it remembered.
- **Who is signed in.** One session read per page, shared by every element on it. Nothing shows
  "Sign in" to someone who is signed in and merely not read yet, and going offline does not look
  like signing out.
- **Keyboards, screen readers, narrow screens.** Anything a drag can do has a keyboard or a
  button, every move is announced, and columns give way in a declared order when the frame runs
  out of room.

None of those is about appearance, and all of them are about the gap between what the API knows
and what the screen claims.

## The table reads with a query

`<sub-entity-table>` is the element most screens start with. It does not draw a fixed page of
rows. It draws whatever its source answers for a query, and changes the query when a person
sorts, filters, searches or turns a page:

```ts
import '@substrat-run/elements/entity-table';
import { api } from './api.generated';

table.source = {
  read: ({ sort, order, limit }) => api.myLists({ sort, order, limit }),
  follow: (next) => api.follow(next),
};
table.columns = [
  { key: 'name', label: 'List', sort: 'name' },
  { key: 'created_at', label: 'Created', kind: 'relative', sort: 'created_at' },
];
```

The source is any object with that shape, a `read` that takes a query and a `follow` for the
`next` link. It does not need the generated client or a Substrat API, though with both the types
line up end to end.

**The query goes in the URL.** `queryToParams` and `queryFromParams` write it and read it back
against an allow-list, so an unknown value in a pasted link falls back to the table's default
instead of producing a broken screen. The page cursor is opaque, so it stays out of the URL. The
elements never touch the URL themselves: the page owns its routing, and the table only reports
that its query changed.

Around that core, everything is opt-in, and a table that sets none of it behaves as a plain
list:

| Part | What a person gets |
|---|---|
| Views, filters, search | Named views, equality filters, a search scoped to the views it covers |
| Column picker | Show, hide and reorder columns, by drag or by buttons that keep focus; layout remembered per browser or stored per account |
| Selection | Shift-ranges, cmd/ctrl-click, select-all, Escape, a selection that survives a page turn |
| Rows people work in | Row open, roving focus, load-on-scroll, context menus, drag with drop rules, long-press on touch |
| Nested rows | Lazy children, per-row reload, tree-grid roles |

A cell is typed by `kind` (`money`, `date`, `badge` and the rest) for a value that only needs
formatting, drawn by Lit with `render`, or **mounted** as a light-DOM element your framework
renders into, so a React component can own a cell and your page's CSS still applies inside it.

## A board is a lifecycle you can drag

`<sub-kanban>` draws cards in columns, one column per state, moved by drag or by keyboard. It is
the one element whose rules come straight out of an engine's invariant, and that makes it worth a
section.

The board asks the screen one question, `canDrop(card, from, to)`, and the right answer is the
lifecycle's own transition table: the same table the vertical's model declares and
`assertTransition` enforces (chapter 4). While a card is held, columns it cannot move to are
dimmed, and the one under it says why. So the screen shows the rule before the person breaks it,
and the operation still refuses it if they find another way.

Saving is optimistic, with the failure honest. The board shows the move at once, marks the card
busy while `move` runs, and puts it back if the operation refuses. A column limit shows "2 / 3"
and warns at the limit, and a strict column refuses the card that would take it over. The
keyboard path is complete: space picks a card up, arrows move it past columns that refuse it,
Escape cancels, and every step is announced.

## A conversation, and an account menu

**`<sub-assistant>`** draws a conversation with an assistant: the transcript and the box to type
in, nothing around it. It reads from an `AssistantModel`, which any source can feed. The source
can be the assistant engine's numbered log from chapter 7, or something else with the same
shape. The dashboard's Ask is drawn through it. The element loads no Web Awesome component of
its own, so it costs little on a page that has none.

**`<sub-user-menu>`** is the account menu Web Awesome does not have: the avatar, the vertical's
own items in slots, then "Switch user" and "Sign out", which it owns because it knows the door's
routes. Signed out, it draws "Sign in". Before the first session read, it draws an empty circle
rather than a guess. Its `account-url` is where a person goes to see every app they belong to,
which a vertical cannot list itself (chapter 8): the auth server's own account page.

## The platform draws its own consoles with them

The customer dashboard and the staff console are both drawn with Web Awesome and the elements,
every control and every table. The shared wrappers live in `packages/ui`, and its theme maps Web
Awesome's tokens onto the platform's own, light and dark.

That is not housekeeping. These two apps are the largest users of the entity table, and a sort,
a filter or a column picker that is wrong there is wrong on a screen somebody uses every day.

The same package is where a generated app starts. `packages/portal-starter` is a small app shell,
Lit over the elements, with themes, a user menu, hash routing and one entity table. The builder
studio copies it as a reference, and it compiles on every pull request so the copy cannot rot.
The to-do reference's app is React 18 using the same elements, which is the evidence that the
framework-free claim holds in practice.

## Files on a screen

A file is the one thing a screen cannot fetch with a JSON call, and two details follow from
that.

A deployed worker serves a file **as the signed-in person**. `workerDoor({ attachments: true })`
mounts `GET /api/attachments/:id`, which streams the file and answers one byte range, and
`DELETE` beside it. A file the person may not read is a `404`, the same as one that does not
exist. The response is hardened before anything can go wrong: `nosniff`, a sandbox content
policy, no caching, and always `Content-Disposition: attachment`. A media element ignores the
disposition, so `<audio src>` plays the file while navigating to it saves it instead of rendering
it.

Where a session cookie does not travel, such as an `<audio>` element on another origin, a link in
a mail or a file an MCP tool returns, an operation mints a **download link**: a URL that reads one
file, as its minter, until it expires. Chapter 4 covers both kinds of link from the operation's
side.

## What is not here

- **No screen is generated for you by the platform.** The builder studio writes screens, as a
  person would. The platform serves them and supplies the parts above.
- **A plugin cannot ship screens into the app it belongs to.** Chapter 8 left that open, and it
  is still open.
- **The elements are `0.x`.** A minor release may change an element's attributes or slots.
- **Only React 18 is exercised in this repository.** The other frameworks' spellings are how
  each treats any custom element. Nothing here runs Vue, Svelte or Angular.

[Building screens](/elements/) is where the reference starts, with
[framework use](/elements/frameworks), [theming](/elements/theming) and the
[element reference](/reference/elements), whose demos run live on in-memory data.

---

**Next:** [The life of one deploy →](/book/10-one-deploy)
