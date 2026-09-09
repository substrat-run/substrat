# The admin console: information architecture

The signed-in admin surface of `demos/auth-server` used to be one scrolling column of panels
(#1278). This is the shape it has instead, and the reasoning behind the parts of it that are
not obvious. It describes what has landed — the shell — and names what has not.

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
files that declare only custom properties are imported; the typography scale is restated
over the system stack. Self-hosting the faces is a follow-up. A CDN request on a customer's
sign-in path is not a follow-up, it is a defect.

## Nav

| Group | Item | What lives there |
|---|---|---|
| Directory | Users | The people this issuer knows; create, promote, ban, remove |
| Directory | Applications | The relying-party registry — client ids, redirect URIs, secrets |
| Sign-in | Sign-in providers | The upstream OAuth/OIDC directories, catalogue and custom |
| Sign-in | BankID | The Swedish e-id, its certificate, and whether it may create accounts |
| Sign-in | Access | Whether a stranger may sign up, and what an upstream sign-in may claim |
| Issuer | Issuer | The discovery document, and what an RP needs to integrate |
| You | Your account | The ways *your* account can be signed into, and where you join another |

Two of these were calls to make rather than inherit from the order the panels grew in:

- **BankID is a sign-in method and sits beside the providers.** It is a separate item, not a
  separate concept: it is configured on completely different terms — an mTLS client
  certificate and an environment, no client id and no redirect URI to register — so one
  editor could not have served both. The grouping says what it is; the split says why it
  has its own screen.
- **Access sits with the sign-in methods, not with the issuer's settings.** On the old page
  it read as a lone toggle stranded between two registries. It is in fact the answer to "who
  may get in at all", which is the same question the providers list answers one upstream at
  a time — so it belongs with them.

## Route table

| Path | Screen | Who may see it |
|---|---|---|
| `/users` | Users | `admin` |
| `/applications` | Applications | `admin` |
| `/providers` | Sign-in providers | `admin` |
| `/bankid` | BankID | `admin` |
| `/access` | Access | `admin` |
| `/issuer` | Issuer | `admin` |
| `/account` | Your account | anyone who can sign in |
| `/` | not a screen — replaced with the first section the viewer may see | — |
| anything else | "No such page", with the way back | — |

**The nav is not the gate.** Every admin call is refused server-side by session + the `admin`
role. Hiding a section from a non-administrator is a courtesy, and getting that wrong is a
layout bug rather than a hole.

Real paths, not a hash router: `src/routes.ts` already serves the SPA for everything that is
not `/api/*`, `/internal/*` or `/.well-known/*`, so a console URL survives a reload and can
be pasted into a support conversation. `src/console/router.ts` is the whole routing layer —
a `useSyncExternalStore` subscription over `popstate` plus one event `navigate()` dispatches,
and no dependency.

## Component inventory

| Used for | From |
|---|---|
| Left nav, groups, active state, overlay behaviour | `SideNav` (`@substrat-run/ui`) |
| The hamburger below 900px | `IconButton` + `SubIcons.menu` |
| Nav icons | `SubIcons.users` / `layers` / `globe` / `box` / `sliders` / `cog` |
| The 404 state | `EmptyState` |
| The responsive breakpoint | `useMediaQuery` |
| Panels, tables, buttons, fields inside a screen | still `tokens.css` classes, re-pointed at the Substrat ramp by `console.css` |
| Card, Field, Centered on the hand-off screens | `src/primitives.tsx` — deliberately **not** the branded set |

**What `@substrat-run/ui` does not have:** a single-person icon. `users` is a group, and
"Your account" is emphatically not the directory, so `console/Console.tsx` inlines Lucide's
`circle-user` locally. A shared icon set earns an entry from a second caller, not the first.

## Migration note

| Old panel (one page) | Now |
|---|---|
| Users + New user | `/users` — and it owns its own read, so a failed list no longer prints above every other panel |
| Your sign-in methods | `/account` |
| Access | `/access` |
| Sign-in providers | `/providers` |
| BankID | `/bankid` |
| Applications | `/applications` |
| Issuer | `/issuer` |
| The lone "Your account" card a non-administrator got | the same console, with `/account` the only item in the nav |

Panel behaviour, API calls and copy moved verbatim. Nothing under `demos/auth-server/src/**`
changed: no model, no migration, no permission and no auth-schema movement.

## Deliberately not here yet

- **List → detail.** A user row is still a dead end. The identity header, the sessions list,
  the ban dialog, "mark the address verified" and the admin read of *another* user's sign-in
  methods (the one real server gap #1278 names) are the next slice, and the server addition
  is a design decision of its own.
- **The light theme.** The console renders on the dark stratum because the panels it wraps
  are dark; a light console needs the panel internals to be components rather than CSS
  classes first, and only then is a theme toggle worth offering.
- **`impersonate-user`.** Mounted, unused, and left that way on purpose: it needs a decision
  about what makes it visible and revocable before it earns a button.
