# Theming the hosted sign-in screens

Every screen a person sees while signing in is styled and worded by one **theme file**: a JSON
object. This page is the whole contract, so it can be handed to Claude with a screenshot or a
brand guide and the answer pasted straight in.

**Where a theme goes.** In the console, either *Branding* (the issuer's theme, used everywhere)
or an application's *Branding* tab (that application only). Press **Edit raw** and paste the
file. An application's keys override the issuer's one at a time.

Over the API, the issuer's theme is `PATCH /api/admin/settings` with `{ "issuerTheme": { … } }`,
which answers 400 naming every problem. An empty object removes the theme.

## Keys

All optional. Colors are `#rgb` or `#rrggbb`, and nothing else.

| Key | What it sets |
|---|---|
| `colorScheme` | `"light"` or `"dark"`: the built-in palette behind every key you leave out. Without it, a dark `colorPanel` (or `colorBackground`) means dark and anything else light. |
| `colorPrimary` | Primary button, links, focus |
| `colorPrimaryForeground` | Text on the primary color |
| `colorBackground` | The page behind the card |
| `colorPanel` | The card |
| `colorInput` | Input fields |
| `colorText` | Body text |
| `colorMutedText` | Secondary text and hints |
| `colorBorder` | The card's edge, input borders, dividers |
| `colorDanger` | Error text |
| `borderRadius` | `0px` to `32px`, for inputs and buttons. The card's is 6px more. |
| `logoUrl` | `https://…` (up to 2,048 characters), or a `data:image/…` up to 256,000 |
| `title` | The sign-in heading, 1 to 60 characters |
| `css` | Raw CSS, under the rules below |
| `text` | Replacement wording per language, described below |

## Raw CSS

Loaded after the built-in stylesheet, on the hosted screens only. It is never applied to the
admin console, so a broken theme cannot lock anyone out of fixing it, and
`/login?builtin=0` always draws the plain screen.

**A theme may not make a network request.** These pages hold a password field, and CSS that can
reach the network can read what is typed into it. A file breaking any of these is refused:

- `url()` only with `data:image/…` or `data:font/…`. Inline every image and font. No web font
  CDN, no `@import`.
- At-rules are limited to `@media`, `@supports`, `@keyframes`, `@font-face`, `@container` and
  `@layer`.
- No `https://` or `//` address inside a quoted string, comments included.
- No backslashes (write `content: "→"`, not `"\2192"`) and no `<`.
- At most 100,000 characters.

## Selectors

These class names are stable. Anything else in the markup can change without notice.

| Selector | Element |
|---|---|
| `body` | The page |
| `.centered` | The full-height wrapper centring the card |
| `.card` | The card |
| `.card .brand-logo` | The logo, an `<img>` above the heading |
| `.card h1` | The heading |
| `.field` | A label wrapping its input |
| `.field > span` | The label text |
| `.field input` | The input |
| `.field .hint` | Help under an input |
| `.btn` | Any button |
| `.btn.primary` | The main action |
| `.btn.link` | A text-only action |
| `.providers .btn` | The sign-in-with buttons |
| `.providers .or` | The "or" divider |
| `.error` / `.notice` | Error and confirmation text |
| `.muted` | Secondary text |
| `.scopes li` | A permission on the consent screen |
| `.lang-switch` | The language choice at the foot of every card |
| `.bankid-qr` | The BankID QR code. Keep its white background, or phones cannot scan it. |

The custom properties behind the color keys are `--bg`, `--panel`, `--panel-2`, `--line`,
`--text`, `--muted`, `--accent`, `--accent-contrast`, `--danger`, `--radius` and `--radius-lg`.
The card's shadow is `--card-shadow`. Prefer the keys, and use `css` for what they cannot say:
layout, logo placement, type.

## Text

`text` replaces any built-in string, per language. Leave out whatever should stay as it is.

```json
{
  "text": {
    "sv": { "common.title": "Logga in", "signin.forOidc": "Välkommen tillbaka." },
    "en": { "common.title": "Sign in", "signin.forOidc": "Welcome back." }
  }
}
```

In the raw editor, **Show all text** fills in every key in both languages, which is the list to
give Claude. Anything left unchanged is dropped on save, so it keeps following the built-in
wording. The keys are defined in `src/messages.ts`.

- Plain text, 1 to 500 characters. Markup is shown as typed.
- `{provider}`, `{email}` and the like are filled in at run time. A string may leave one out but
  cannot use one its built-in does not have.
- `common.title` is the sign-in heading, and wins over the theme's `title` for that language.
- An application's entries override the issuer's one at a time.
- This covers the screens. The errors from the server and the emails keep the built-in wording.

## Example

```json
{
  "colorScheme": "light",
  "colorPrimary": "#e5833a",
  "colorPrimaryForeground": "#ffffff",
  "colorBackground": "#f8fafc",
  "borderRadius": "8px",
  "logoUrl": "https://cdn.example.com/logo.svg",
  "title": "Sign in",
  "css": ".card { width: 440px; padding: 40px; } .card .brand-logo { margin: 0 auto 28px; max-height: 72px; } .card h1 { display: none; } .btn.primary { padding: 13px; font-size: 16px; }"
}
```

Hiding `.card h1` hides every screen's heading, so check the sign-up and consent screens too.
