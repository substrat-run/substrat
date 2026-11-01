# The admin console: information architecture

The signed-in admin surface of `demos/auth-server` used to be one scrolling column of panels
(#1278). This is the shape it has instead, and the reasoning behind the parts of it that are
not obvious. It describes what has landed — the shell, and the detail screens under it — and
names what has not.

## The boundary this document is about

The SPA is **two surfaces behind one origin**, and they have different audiences:

- `auth/` — `/login`, `/signup`, `/consent`, `/reset-password`. These answer a relying
  party's authorize request. Someone here is signing into *a customer's application* and
  arrived through this issuer by accident of architecture. They are themed per client from
  its stored `metadata.theme` and carry **no Substrat identity at all**.
- `console/` + `views/` — the operator's screens, and the one screen an ordinary person of
  this issuer reaches. This is the product, so this is where the branding is.

Everything below is about the second one. The mechanics of keeping them apart:
`src/tokens.css` stays the theming vocabulary (renaming one of its custom properties is a
breaking change for every themed client), `src/console/console.css` adds the Substrat tokens
*beside* it and scopes every rule it writes to `.console-root`, and `main.tsx` loads
`console.css` first so `tokens.css` wins the one property name the two sets share
(`--radius-lg`).

**Fonts, decided explicitly:** `@substrat-run/ui/styles.css` is not imported whole, because
it pulls Geist from the Google Fonts CDN and this is a single bundle — an unscoped import
would put a third-party request on the login path of every relying party. The three token
files that declare only custom properties are imported; the typography scale is restated.
A CDN request on a customer's sign-in path is not a follow-up, it is a defect.

The faces themselves are **self-hosted**, which was the follow-up this paragraph used to
defer: `src/console/fonts.css` serves Geist and Geist Mono from the issuer's own origin — the
woff2 rides along in `src/assets.generated.ts` like every other asset, so there is no external
hop at all. Variable rather than static weights and the Latin subset only, because the whole
SPA is inlined into the pushed worker and every face is paid for in bundle bytes; the system
stack stays behind each as the `font-display: swap` fallback. That file states the three
size choices and what each one costs.

## Nav

The sections follow Auth0's dashboard, which is the vocabulary an operator who has run an
identity provider already has (`console-redesign.md` §3 has the reasoning).

| Group | Item | What lives there |
|---|---|---|
| — | Overview | Counts, federated sign-ins over seven days, recent failures, and a "get started" card while only the seeded clients exist |
| Applications | Applications | The relying-party registry: client ids, redirect URIs, secrets |
| Applications | APIs | The RFC 8707 resources this issuer mints tokens for, and the `MACHINE_SCOPES` ceiling. Read-only |
| Authentication | Connections | One list over three stores: the password database, the upstream providers, BankID |
| Authentication | Security | How an upstream sign-in links to an existing account |
| User management | Users | The people this issuer knows; create, invite, import, promote, ban, remove |
| Monitoring | Logs | The federated round trips, and why a failed one failed |
| Issuer | Settings | The discovery document and what an RP needs to integrate |
| You | Your account | Shown in the nav only to a non-administrator; an administrator reaches it from the account menu |

Two placements are calls rather than inheritances:

- **Connections is one list.** The upstream providers, BankID and the password database grew up
  as three screens, but they are one idea: a source of identities that applications are
  enabled for. Each connection's **Applications** tab is a view of each client's
  `metadata.signIn`, not new storage. A toggle rewrites that one entry through the same PATCH
  the application's own Connections tab uses. The pure arithmetic of what a toggle writes is
  `views/connections/policy.ts`, tested by `test/console-connections.test.ts`.
- **The sign-up switch is on the password database** (the Username-Password connection), which
  is the thing it switches. It is still the `ALLOW_SIGNUP` env-spec key. Security keeps what
  is about every connection at once.

## Route table

| Path | Screen | Who may see it |
|---|---|---|
| `/` | Overview | `admin`; anyone else is sent to `/account` |
| `/applications` | Applications | `admin` |
| `/applications/<client id>[/connections\|/branding\|/logs\|/raw]` | Application detail; Settings is the bare URL | `admin` |
| `/apis` | APIs | `admin` |
| `/connections` | Connections | `admin` |
| `/connections/<id>[/applications\|/raw]` | Connection detail (`password`, `bankid`, or a provider id) | `admin` |
| `/security` | Security | `admin` |
| `/users` | Users | `admin` |
| `/users/<id>[/identities\|/sessions\|/logs\|/raw]` | User detail; Details is the bare URL | `admin` |
| `/logs` | Logs | `admin` |
| `/logs/<id>` | One log entry, with the other hops of the same attempt | `admin` |
| `/settings` | Settings | `admin` |
| `/account` | Your account | anyone who can sign in |
| `/providers[/<id>]`, `/bankid[/settings]`, `/access`, `/sign-in-log`, `/issuer` | redirected (replace, not push) to where that screen lives now | `admin` |
| anything else | "No such page", with the way back | — |

**A tab is a place.** Each detail screen's tabs come from a fixed list in `paths.ts`, the default
tab is the bare URL, and an unknown tab is not a screen. So a tab survives a reload, a pasted
link and the sign-in a stale session triggers, on the same terms as the detail URL itself. The
detail view is keyed by its id, not its tab, so moving between tabs keeps the record's read and
any half-edited form. Each form tab saves only its own fields.

**A detail screen is a screen under its section, not a section of its own.** The nav keeps the
parent lit, and each one is read *after* the permission filter, so a non-administrator pasting
one gets the same "no such page" the nav's own courtesy already implies. The id parsers in
`src/console/paths.ts` are deliberately strict about the shape rather than accepting any tail.

**The nav is not the gate.** Every admin call is refused server-side by session + the `admin`
role. Hiding a section from a non-administrator is a courtesy, and getting that wrong is a
layout bug rather than a hole.

Real paths, not a hash router: `src/routes.ts` already serves the SPA for everything that is
not `/api/*`, `/internal/*` or `/.well-known/*`, so a console URL survives a reload and can
be pasted into a support conversation. `src/console/router.ts` is the whole routing layer —
a `useSyncExternalStore` subscription over `popstate` plus one event `navigate()` dispatches,
and no dependency.

**Every nav item is a real link.** `AppShell` takes an `href` per item and only swallows the
plain left click; ⌘/Ctrl-click, middle-click, Copy Link and Open in New Tab are handed to
the browser. A URL that cannot be copied out of the chrome that shows it is not a URL.

### A pasted URL survives the sign-in it triggers

The table above is also an **allowlist** — `returnTarget()` in `src/console/routes.ts`, over
the table itself plus the detail parsers in `src/console/paths.ts` — and that is why both live
apart from the console that renders them: the signed-out screens need them too.

Someone pasted `/applications`, has no session, and is shown the sign-in screen. The path is
what they were sent, so it is what they get back:

| Path they arrived on | Where signing in lands them |
|---|---|
| a path in the route table | that path |
| a detail or tab URL `paths.ts` recognises | that path, re-composed from what it parsed |
| a pre-regroup URL (`/providers/google`) | where that screen lives now (`legacyTarget`) |
| `/login`, `/signup`, `/consent`, `/reset-password` | `/` |
| anything else | `/` |

A detail URL is the second row for the reason it exists at all: it is the link an operator
pastes into a support conversation, and it is exactly where the person opening it meant to
land. It survives on the same terms as the table — by the strict parsers above, never by being
whatever the address bar held.

Password and BankID sign-in never leave the page, so for those it is only a matter of not
overwriting the address bar. A **social** sign-in does leave: the value is handed to the
provider as `callbackURL` and comes back through a redirect the issuer performs, which is
exactly why an allowlist of literal paths rather than "whatever was in the address bar" —
the alternative is an open redirect with a round trip through Google attached. The refusal
(`errorCallbackURL`) comes back to the same screen, so a retry still lands where it was going.

### The drawer below 900px

The sidebar becomes an overlay, and an overlay has to answer for focus. This lives in
`AppShell` (`drawerBelow={900}`), not in the console, so the next app that wants a drawer
gets the same answers. It renders *before*
the hamburger in DOM order, so opening it and leaving focus on the trigger would send the
next Tab into the page behind the scrim. Opening moves focus to the first nav link, Escape
closes, and closing — by Escape, by the scrim, or by picking a section — puts focus back on
the hamburger rather than leaving it on an element that is now `visibility: hidden`. Visibility is transitioned
on the way out only: the drawer has to be visible in the frame the effect focuses its first
link, and `focus()` on an element still `visibility: hidden` does nothing — which is how the
first version of this drawer left focus on the hamburger after all.

## Component inventory

| Used for | From |
|---|---|
| Sidebar, groups, active state, top bar, crumbs, drawer below 900px | `AppShell` (`@substrat-run/ui`) — the dashboard's shell, lifted out of `DashShell` with the console as its second caller |
| The issuer card at the top of the sidebar | `IssuerCard` in `Console.tsx`: the wordmark, and a copy button for the issuer URL where the dashboard has its team switcher |
| The account row and its menu (Your account · theme · sign out) | `AccountMenu` |
| Nav icons | `SubIcons.users` / `layers` / `globe` / `box` / `sliders` / `scroll` / `cog` |
| The 404 state | `EmptyState` |
| Panels, tables, buttons, fields inside a screen | still `tokens.css` classes; `console.css` redefines that vocabulary in terms of Substrat tokens under `.console-root`, so they follow the theme |
| Card, Field, Centered on the hand-off screens | `src/primitives.tsx` — deliberately **not** the branded set |

**What `@substrat-run/ui` does not have:** a single-person icon. `users` is a group, and
"Your account" is emphatically not the directory, so `console/routes.ts` inlines Lucide's
`circle-user` beside the route it belongs to. A shared icon set earns an entry from a second
caller, not the first.

**The theme.** `data-theme` on the console root, from `console/theme.ts`: `?theme=` on load,
then the operator's last choice, then the system's. On the root rather than `<html>`, because
the hand-off screens share the document and are themed by the relying party. tokens.css's own
custom properties (`--panel`, `--line`, `--muted`, …) are dark by construction, so
`console.css` redefines each in terms of a Substrat token on `.console-root` — never `:root`,
which is where a client's stored theme is applied — and everything tokens.css draws inside
the console follows the toggle with no per-theme rule.

**The console is its own chunk.** `App.tsx` imports it with `lazy()`: everyone a relying party
sends to `/login` loads this SPA, and none of them needs the operator's screens. Every file in
`app/dist` is inlined into the worker (`scripts/gen-assets.mjs`), so the chunk is served like
the entry.

## Migration note

| Before the regroup | Now |
|---|---|
| Sign-in providers, `/providers/<id>` | Connections, `/connections/<id>` |
| BankID, `/bankid/settings` | the `bankid` connection, `/connections/bankid` |
| Access: the sign-up switch | the password database's Settings tab, `/connections/password` |
| Access: account linking | Security |
| Sign-in log | Logs, with Auth0 type codes (`s`, `f`) and an entry screen per row |
| Issuer | Settings |
| One long application editor | Settings · Connections · Branding · Logs · Raw tabs |
| User detail panels | Details · Identities · Sessions · Logs · Raw tabs |
| `/` redirected to the first section | Overview |

The old URLs redirect. Three read-only admin routes were added for these screens: `client_id` /
`user_id` filters and a by-id read on `/api/admin/sign-in-log`, and `/api/admin/resources`.
Nothing else under `src/**` changed: no model, no migration, no permission, no auth-schema
movement.

## Deliberately not here yet

**List → detail has since landed, and is no longer on this list.** `/users/<id>` (#1348) gave
the user row the identity header, the sessions list, the ban dialog and "mark the address
verified", together with the admin read of *another* user's sign-in methods — the one real
server gap #1278 named. #1402 added the lever beside that read: an administrator can take one
method away, and the route refuses both a row belonging to a different user than the URL names
and the removal of somebody's last way in. `/applications/<client id>` (#1372),
`/providers/<provider id>` (#1384) and `/bankid/settings` (#1391) followed for the same
reason a detail screen is worth having at all — what an operator was reading survives a reload
and can be pasted into a support conversation. Self-hosted faces (#1424) closed the other
follow-up this document deferred, above.

What is still deliberately absent:

- **`impersonate-user`.** Mounted, unused, and left that way on purpose: it needs a decision
  about what makes it visible and revocable before it earns a button.
- **Searching users past the first page from ⌘K.** The palette filters `listUsers()`, which
  answers at most 200 rows. A server-side `q=` read is Phase 3's `/api/v2`.
- **A per-entry Raw tab on `/logs/<id>`.** The entry is one screen with a Raw panel, since a
  log row has nothing to edit and one more tab would only hide half of it.
