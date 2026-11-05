# @substrat-run/elements

Web components for a vertical's screens, built so a project gets a table that is good and
looks like *its* theme without writing either. Three components so far, dogfooded in
`demos/todo/app` (`#/table`, and its header). Still `0.x`: a minor release may change an
element's attributes or slots.

## What's in it

- **`<sub-entity-table>`** — the rows of one paged read and the actions a row allows. Give it
  a `source` (`{ first, follow }` — the generated client's read and `follow`), `columns` and
  `actions`. It tells a 403 wall from an empty list, keeps the rows when one action is
  refused, re-reads when an action finds the view stale (409/404), follows `next` on
  "Load more", and drops `priority` 3, then 2 columns while the table is wider than its frame.
- **`<sub-user-menu>`** — the account menu: who is signed in, your own items (slotted
  `<wa-dropdown-item>`s), then "Switch user" and "Sign out", which it owns because it knows
  the auth endpoints (`/api/auth/*`). Every built-in part is a slot with a default, and
  `sub-sign-out` / `sub-switch-user` are cancelable. Signed out it draws "Sign in"; before
  the first session read it draws an empty circle, never "Sign in". `show="avatar|name|email"`.
- **`<sub-avatar>`** — the same identity without a menu: picture or initials (by grapheme,
  coloured by principal), optionally the name or email beside it. Reads the session itself,
  or draws the `session` property you hand it.
- **`SessionStore` / `sessionAt(url)`** — the session read both share: once per URL per
  page, re-read when the tab comes back into view, and a failed refresh never signs
  anybody out on screen.
- **`EntityTableModel`** — everything above that is not drawing, with no DOM in it, so a
  second renderer (React Native, later) gets the same answers from the same code.
- **Themes** — `themes/base.css` is Web Awesome's default theme (the `--wa-*` tokens);
  `themes/ledger.css` (dense, flat, cool) and `themes/atelier.css` (warm, serif headings,
  roomy) are classes over it. A theme is token values only — no selectors into components.

## Using it

```sh
npm install @substrat-run/elements
```

```ts
import '@substrat-run/elements';
import '@substrat-run/elements/themes/base.css';
import '@substrat-run/elements/themes/ledger.css';
// <html class="sub-theme-ledger">, plus `wa-dark` for dark mode
```

## How it is built

[Lit](https://lit.dev) elements on [Web Awesome](https://webawesome.com)'s free, MIT core:
its controls (`wa-button`, `wa-callout`, `wa-spinner`) inside, and its tokens for every
style, so an element follows any Web Awesome-shaped theme with no theme code of its own.
`src/internal/substrat-element.ts` is Web Awesome 3.14.0's base element, copied — upstream
marks it internal and leaves it out of the package's `exports` — with each change from
upstream listed in its header. Web Awesome's data grid, date picker, theme builder and
patterns are Pro; this package uses none of them.
