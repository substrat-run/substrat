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

The rows of one paged read, with the actions a row allows. Give it the generated client's read as
its `source`, plus `columns` and `actions`, as properties. It tells a 403 from an empty list,
keeps the rows when one action is refused, reads again when an action finds the view stale (409
or 404), follows `next` on "Load more", and drops lower-priority columns while the table is wider
than its frame. `EntityTableModel` is everything here that is not drawing, with no DOM in it.

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
