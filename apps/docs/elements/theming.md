# Theming

Theming is the hard part of a component library, and here it is one mechanism. Every element and
every Web Awesome control takes its colours, sizes, fonts and radii from `--wa-*` CSS custom
properties. They hold no colours of their own. Change the tokens and the whole app changes, in
every framework, with no component code touched.

## Start from a theme

```ts
import '@substrat-run/elements/themes/base.css';
import '@substrat-run/elements/themes/ledger.css';
```

```html
<html class="sub-theme-ledger">
```

| Theme | Look |
|---|---|
| `base.css` | Web Awesome's default. Always import this first |
| `ledger.css` | Dense and flat, with hairline borders and one cool accent, for screens people work in all day |
| `atelier.css` | Warm and roomy, with serif headings |

## Dark mode

Add `wa-dark` to `<html>`, and remove it to go back:

```ts
document.documentElement.classList.toggle('wa-dark', dark);
```

## Write your own

A theme is token values and nothing else. Put them in a class, in Web Awesome's last layer, so
they win over its theme and still lose to your own unlayered CSS:

```css
@layer wa-theme-overrides {
  .my-theme {
    --wa-color-brand-50: #5749d8;
    --wa-font-family-body: 'Inter', sans-serif;
    --wa-border-radius-m: 6px;
    --wa-form-control-height: 2rem;
  }

  .my-theme.wa-dark {
    --wa-color-surface-default: #141721;
  }
}
```

Import it after `base.css`, and put the class on `<html>`.

Four kinds of token do most of the work:

- **Colour scales**, such as `--wa-color-brand-05` to `--wa-color-brand-95`, and the same for
  `neutral`.
- **Semantic colours**, such as `--wa-color-surface-default`, `--wa-color-text-normal` and
  `--wa-color-brand-fill-loud`.
- **Scales**: `--wa-font-size-scale`, `--wa-space-scale` and `--wa-border-radius-scale` resize
  everything at once. `0.875` on the font scale makes 14px the base size.
- **One-offs**, such as `--wa-form-control-height`, `--wa-font-family-body` and the
  `--wa-shadow-*` set.

[Web Awesome's theming docs](https://webawesome.com/docs/themes) list them all.

::: tip
A misspelt custom property isn't an error anywhere. It just leaves the default standing, so check
a new theme in the browser, in light and in dark.
:::

## You already have design tokens

Point `--wa-*` at them rather than copying the values:

```css
@layer wa-theme-overrides {
  .my-theme {
    --wa-color-surface-default: var(--surface-card);
    --wa-color-text-normal: var(--text-primary);
    --wa-color-surface-border: var(--border-default);
  }
}
```

Put the class on the same element that defines your tokens. If your tokens already switch for dark
mode, those values follow without a dark block, but `wa-dark` still has to go on `<html>` for the
tokens you didn't map.

## Your own screens

Your CSS can read the same tokens, so a hand-written screen follows the theme too:

```css
.panel {
  background: var(--wa-color-surface-default);
  border: 1px solid var(--wa-color-surface-border);
  color: var(--wa-color-text-normal);
}
```

`themes/native.css` applies Web Awesome's styles to plain `<button>`, `<input>` and `<table>`
markup, in a layer your own CSS still beats.

## One element, further

The table goes from the outside in. Reach for each step only if the one before can't do it:

1. The theme's `--wa-*` tokens.
2. Its own tokens, such as `--sub-table-row-height` and `--sub-table-header-background`.
3. `density="compact"`.
4. `::part()`, for example `sub-entity-table::part(header-cell)`.

[The reference](/reference/elements#sub-entity-table) has the full lists.
