# Web Awesome

[Web Awesome](https://webawesome.com) is the component library under the elements. Its free core
is MIT-licensed web components, built to be themed through CSS tokens. It gives a Substrat app
the form controls, and its token system is what makes [theming](/elements/theming) work the same
everywhere. The elements are [Lit](https://lit.dev) components built on top of it.

## The controls

One import registers the controls we use in Substrat apps:

```ts
import '@substrat-run/elements/controls';
```

| Group | Controls |
|---|---|
| Actions | `wa-button`, `wa-dropdown`, `wa-dropdown-item` |
| Forms | `wa-input`, `wa-textarea`, `wa-select`, `wa-option`, `wa-checkbox`, `wa-switch`, `wa-radio`, `wa-radio-group` |
| Feedback | `wa-callout`, `wa-spinner`, `wa-tag`, `wa-badge` |
| Layout | `wa-card`, `wa-dialog`, `wa-divider`, `wa-tab-group`, `wa-tab`, `wa-breadcrumb`, `wa-breadcrumb-item` |

```html
<wa-input label="Name" required></wa-input>
<wa-select label="Status">
  <wa-option value="open">Open</wa-option>
  <wa-option value="closed">Closed</wa-option>
</wa-select>
<wa-button variant="brand">Save</wa-button>
```

The list is short on purpose. It's the vocabulary a person or an agent writes screens in, and a
short list is one nobody has to guess at.

## Anything else from the free core

The free core has more than that: dialogs, drawers, tabs, tooltips, cards and more. Import the
ones you need directly. They take the same theme, because they read the same tokens:

```ts
import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
```

Add `@awesome.me/webawesome` to your app at the version `@substrat-run/elements` depends on, so
the page registers one copy of each element.

## Free and Pro

Web Awesome also sells a Pro tier, which includes its data grid, date picker, theme builder and
patterns. `@substrat-run/elements` uses none of it, so nothing here needs a licence. Nothing stops
you from buying Pro for your own screens: it's a separate choice, and it reads the same tokens.

`<sub-entity-table>` isn't a replacement for Pro's data grid. A data grid is a general component
that can sort and filter rows it's given. The table is built around one server-side read: the
query goes to your API, and it knows what a Substrat read answers, from keyset links to 403s.
