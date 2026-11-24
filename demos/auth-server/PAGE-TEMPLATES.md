# Page templates for the hosted sign-in screens

A **page template** is one HTML page, written in [Liquid](https://shopify.github.io/liquid/), that
every hosted sign-in screen is drawn inside. Use it for what a [theme](THEMING.md) cannot do: a
header and footer, a two-column layout, a picture beside the form. It is written the way Auth0's
Universal Login page templates are, so a template made for Auth0 can usually be pasted in (see
[Coming from Auth0](#coming-from-auth0)).

A theme still styles the sign-in form itself. The two work together: the template draws the page,
the theme draws the card in it.

Without a template, the screens are exactly the built-in page. `/login?builtin=0` always draws the
built-in page, template or not.

## Where it goes

- **In the console:** *Branding*, then *Page template*. Paste or write the template, pick a screen
  and a language to preview it, and press **Save template**. **Reset to default** removes it.
- **Over the API:** Auth0's Management API endpoints, with a machine client holding
  `read:branding`, `update:branding` or `delete:branding` (each must also be in the issuer's
  `MACHINE_SCOPES` setting; see [`MANAGEMENT-API.md`](MANAGEMENT-API.md)):

  ```http
  PUT /api/v2/branding/templates/universal-login
  Authorization: Bearer <token>
  Content-Type: application/json

  { "template": "<!DOCTYPE html>…" }
  ```

  `GET` answers `{ "body": "…" }`, or 404 when there is none. `PUT` answers 201 when it created the
  template and 204 when it replaced it. `DELETE` answers 204. The console's own door is the same
  contract at `/api/admin/branding/templates/universal-login`, for an administrator's session.

There is one template per install. An application cannot have its own; use the application's
theme (its *Branding* tab) to change how its screens look.

Every save and removal writes a log line naming who made it (an administrator's user id or a
machine client's id), with the template's size and the start of its SHA-256. The template itself
is not logged. The issuer has no audit table for its settings; this line is the record.

## The two tags

Both are required, each exactly once on every screen.

| Tag | Where | What it draws |
|---|---|---|
| `{%- auth0:head -%}` | In `<head>` | The sign-in app's stylesheet and scripts, and a viewport meta tag |
| `{%- auth0:widget -%}` | In `<body>`, where the form goes | The sign-in form: whichever screen the person is on |

The head carries no `<title>`, no icon and no `<meta charset>`: set your own. A template that
leaves either tag out, or draws one twice or not at all on some screen (inside an `{% if %}`, say),
is refused on save.

## Variables

Anything not set is empty, as in Auth0: `{{ user.name }}` prints nothing on a screen with no one
signed in. Guard with `{% if user %}` where an empty value would read oddly.

| Variable | What it holds |
|---|---|
| `application.name` | The application the person is signing in to |
| `application.id`, `application.client_id` | Its client id (both names hold the same value) |
| `application.logo_url` | Its logo, when it has an `https` one |
| `application.metadata.<key>` | Its metadata entries whose value is a string |
| `branding.logo_url` | The theme's logo |
| `branding.colors.primary` | The theme's `colorPrimary` |
| `branding.colors.page_background` | The theme's `colorBackground` |
| `locale` | `sv` or `en`: the language the screen is in |
| `dir` | Always `ltr` |
| `prompt.name` | The step: `login`, `signup`, `consent`, `reset-password` or `invitation` |
| `prompt.screen.name` | The screen, in the table below |
| `tenant.friendly_name` | The install's name, when the platform installed it |
| `tenant.enabled_locales` | The languages the screens offer: the theme's `languages`, or both |
| `user.name`, `user.email`, `user.picture` | The signed-in person, when there is one. Nothing else about them |

`application` is set only when the person arrived from an application's sign-in request that this
issuer signed and that has not expired. A page opened with a bare `?client_id=…` has no
`application`, so the page cannot be used to find out which applications exist.

The `branding` values are the theme the screen is drawn with: the application's theme over the
issuer's, the same merge the screens use.

### Screens

| `prompt.screen.name` | `prompt.name` | Shown when |
|---|---|---|
| `login` | `login` | Signing in. Also what a sign-up link shows when sign-up is closed |
| `signup` | `signup` | Creating an account (`/signup`, `screen_hint=signup` or `prompt=create`) |
| `consent` | `consent` | Agreeing to what an application asks for |
| `reset-password` | `reset-password` | Choosing a new password from a reset link |
| `accept-invitation` | `invitation` | Accepting an invitation |
| `github-email` | `login` | Giving an address when GitHub shares none (no Auth0 counterpart) |

The screens a person moves between without loading a new page (from sign-in to "create an account",
say) keep the page they started on. Use the theme's selectors in `THEMING.md` to style the form.

## Rules

- **Output is escaped.** `{{ application.name }}` prints `<` as `&lt;`, so a name containing markup
  shows as text. The `raw` filter is not available. The `escape` filter escapes a second time.
- **One file.** `{% include %}`, `{% render %}` and `{% layout %}` are not available.
- **Unknown filters and tags are refused** on save, naming them.
- **At most 102,400 bytes**, Auth0's limit.
- **A bounded amount of work.** A page may render up to 300,000 steps, counting each block it
  renders (every loop iteration is one) and each character it writes. A real page uses a few
  thousand. Where the runtime's clock moves while a page renders (it does not in a Cloudflare
  worker, so there the budget is what holds), a render also stops after one second. A template over
  either limit is refused on save.
- **Checked on every screen.** A save renders the template for each screen above in both languages,
  with a sample application and, on the consent screen, a sample signed-in person. A template that
  fails on any of them is refused, naming the screen and the reason.
- **Never a locked door.** If a saved template still fails when a page is opened (its data differs
  from the samples), the built-in page is served instead and the failure is logged with the screen
  and the reason.

## What the page may load

A templated page carries a `Content-Security-Policy`. These pages hold a password field, and a page
that can reach another site can send what is typed into it there, so the policy keeps everything on
this issuer:

- **Scripts:** only the sign-in app's own, which carry a per-request nonce. A template's own
  `<script>` does not run, inline or remote.
- **Images:** this issuer, `data:` URLs, and the sites of the logos and the person's picture in the
  variables above. Put other images in as `data:image/…`.
- **Stylesheets and fonts:** this issuer, inline `<style>` blocks, and `data:` fonts. A web font from
  a font service does not load: inline it as `data:font/…` in an `@font-face`.
- **Connections and form posts:** this issuer only.

The policy is the same for every install and cannot be relaxed. The built-in page, with no
template, is served without one, as before.

## Example

```liquid
<!DOCTYPE html>
<html lang="{{ locale }}">
  <head>
    {%- auth0:head -%}
    <meta charset="utf-8">
    <title>{% if application %}{{ application.name }} · {% endif %}Acme</title>
    <style>
      body { display: grid; grid-template-columns: 1fr 1fr; min-height: 100vh; margin: 0;
             background: {{ branding.colors.page_background | default: "#f8fafc" }}; }
      .aside { background: {{ branding.colors.primary | default: "#e5833a" }}; color: #fff; padding: 48px; }
      .main { display: grid; place-items: center; }
      @media (max-width: 800px) { body { grid-template-columns: 1fr; } .aside { display: none; } }
    </style>
  </head>
  <body class="screen-{{ prompt.screen.name }}">
    <div class="aside">
      {% if branding.logo_url %}<img src="{{ branding.logo_url }}" alt="Acme" height="40">{% endif %}
      {% if prompt.name == "signup" %}
        <h1>{% if locale == "sv" %}Välkommen till Acme{% else %}Welcome to Acme{% endif %}</h1>
      {% else %}
        <h1>{% if locale == "sv" %}Logga in på Acme{% else %}Sign in to Acme{% endif %}</h1>
      {% endif %}
      <p><a href="https://example.com/help" style="color:#fff">
        {% if locale == "sv" %}Behöver du hjälp?{% else %}Need help?{% endif %}</a></p>
    </div>
    <div class="main">
      {%- auth0:widget -%}
    </div>
  </body>
</html>
```

## Coming from Auth0

Most Auth0 templates work as they are. What to check:

- **Variables served here:** the ones in the table above. Auth0's `prompt.screen.texts`,
  `organization`, `custom_domain`, `transaction`, `correlation_id`, `state` and the extra `user`
  fields (`user_id`, `user_metadata`, `given_name`, …) are not set, so they print as nothing.
  Replace `prompt.screen.texts.*` with your own text per `locale`.
- **Screen and prompt names** are the ones in the table above. Auth0 has many more (MFA, passwordless,
  device flow) that this issuer does not have.
- **Remote assets do not load.** Google Fonts, a CDN stylesheet, a tracking script, a remote
  background image: see [What the page may load](#what-the-page-may-load). Inline fonts and images as
  `data:` URLs.
- **Your own scripts do not run.** Auth0 runs a template's scripts; this issuer does not.
- **`raw` is refused** and `escape` escapes twice: drop both.
- **Auth0's widget classes** (`_widget-auto-layout` and the like) mean nothing here. The form is styled
  with a theme; its stable selectors are in `THEMING.md`.
- **`application.metadata`** holds only string values, as Auth0's client metadata does.
- **Stricter on save:** Auth0 checks the tags and the syntax. This issuer also renders every screen,
  so an `{% if %}` that hides the widget on one screen, or an unknown filter, is caught then.
- **No 402 or 409:** every install has templates, and the last write wins.

## Running it locally

The page template is drawn by the worker: `pnpm cf:dev` (`wrangler dev`) draws it, and so does the
hosted issuer. `pnpm dev` serves the screens through Vite, without the template; its console can
still set one, and the preview shows the template around an empty form, since nothing is built.
