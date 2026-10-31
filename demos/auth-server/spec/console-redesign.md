# The admin console, redesigned: the dashboard's look, Auth0's shape

**Status: proposal.** Nothing here has landed. When a phase lands, its part moves into
[console-ia.md](console-ia.md), which keeps describing what *is*. This file describes what
should be, and why.

Two changes, which can ship separately:

1. **Look.** The console should read as a sibling of the Substrat dashboard (`apps/dashboard/web`).
   Today it is a dark-only column of `tokens.css` panels inside `SideNav`.
2. **Shape.** The console, its admin API and its log should follow Auth0's model: tenant →
   applications / APIs / connections → users. That model is the vocabulary every operator
   who has run an identity provider already knows, and it is the one
   [AuthHero](https://github.com/markusahlstrand/authhero) (`apps/admin`, `/api/v2`)
   reproduces closely enough for go-auth0 and Terraform to drive it. AuthHero is the
   reference throughout. We borrow its structure, not its code, and only where Better Auth
   already holds the data.

Untouched by either change: the hosted sign-in pages (`/login`, `/signup`, `/consent`,
`/reset-password`). They answer a relying party, are themed per client, and carry no Substrat
identity (console-ia.md, "The boundary"). Their **paths** are part of the OIDC contract
(`loginPage` / `consentPage` in `src/auth.ts`), so §5 reorganises what they render, never
where they live.

## 1. The look: lift the dashboard shell into `@substrat-run/ui`

The dashboard's chrome is `DashShell` (`apps/dashboard/web/src/components/DashShell.tsx`)
plus `Page`, `GridTable` and `Row` (`components/layout.tsx`). It has:

- a 232 px card-surface sidebar with uncapitalised group titles,
- a context switcher at the top and an account row with an upward menu at the bottom,
- a 56 px top bar holding breadcrumbs and a ⌘K search pill,
- a centred 1200 px content column,
- caps-header grid tables on 12 px-radius cards,
- light **and** dark themes on the shared tokens.

The console has none of that. It uses `SideNav` and the panel classes `console.css` re-points.

**Proposal: move the shell into `@substrat-run/ui` and use it in both apps.**

- The pieces move: `AppShell` (generalised from `DashShell`: nav groups, a top slot, a
  footer slot, crumbs, actions), `Page`, `GridTable`, `Row`, `Avatar`, plus a new `Tabs` and
  a `DetailHeader`.
- console-ia.md's rule was that a shared component "earns an entry from a second caller".
  The console is that second caller.
- The dashboard keeps its own `TeamSwitcher`, `ObsChildren` and notifications in the slots.
- The drawer behaviour below 900 px (focus to the first link, Escape closes, focus returns to
  the trigger) is already specified in console-ia.md. It goes into `AppShell` once, so the
  dashboard gets it too.

What the console puts in each slot:

| Slot | Dashboard | Auth console |
|---|---|---|
| Top of sidebar | Team switcher | Issuer card: the issuer's hostname and a copy button for the issuer URL. No switcher: one issuer per install |
| Footer | Account row → settings / theme / sign out | Same component. "Settings" means `/account` |
| Crumbs | Team › Section › Item | Issuer › Section › Item (`auth.substrat.net › Applications › Dashboard`) |
| ⌘K | Command palette | Jump-to: users by email, applications by name or client id, connections. One `q=` read per kind (§4) |

**Light theme.** console-ia.md deferred it until "the panel internals [are] components rather
than CSS classes". This redesign does that conversion, so the deferral ends here.
- The console follows the dashboard's `?theme=` and the account menu's toggle.
- `console.css` shrinks to fonts plus the `.console-root` scope.
- The self-hosted Geist rule stays as it is: still no CDN request on any page this origin serves.

**Bundle cost.** The SPA is inlined into the pushed worker, so the shell's bytes are paid on
the login path too, unless the console is code-split behind a lazy import. Phase 1 splits it:
`auth/` must not grow by the console's weight.

```
┌──────────────────────┬──────────────────────────────────────────────────────────────┐
│ ◇ auth.substrat.net ⧉│  auth.substrat.net › Applications › Dashboard     [⌘K Search]│
│                      ├──────────────────────────────────────────────────────────────┤
│ ▦ Overview           │  ◼ Dashboard                          [Rotate secret] [⋯]    │
│                      │    Regular web app · dsh_01J…  ⧉ · enabled                   │
│ Applications         │  ─────────────────────────────────────────────────────────── │
│ ▤ Applications       │  Settings  Connections  Branding  API access  Logs  Raw      │
│ ⬡ APIs               │  ┌────────────────────────────────────────────────────────┐  │
│                      │  │ Name                 Dashboard                         │  │
│ Authentication       │  │ Allowed callback URLs  https://app.substrat.net/api/…  │  │
│ ⇄ Connections        │  │ Allowed logout URLs    https://app.substrat.net        │  │
│ ⛨ Security           │  │ Skip consent           ●                               │  │
│                      │  └────────────────────────────────────────────────────────┘  │
│ User management      │                                                              │
│ ☺ Users              │                                                              │
│                      │                                                              │
│ Branding             │                                                              │
│ ◐ Universal Login    │                                                              │
│ ✉ Emails             │                                                              │
│                      │                                                              │
│ Monitoring           │                                                              │
│ ≡ Logs               │                                                              │
│                      │                                                              │
│ ⚙ Settings           │                                                              │
│ ──────────────────── │                                                              │
│ (MA) Your name    ⌃  │                                                              │
└──────────────────────┴──────────────────────────────────────────────────────────────┘
```

## 2. The shape: Auth0's model, laid over what Better Auth holds

Each Auth0 concept below already has data behind it in this issuer. The redesign renames and
regroups. It does not invent storage. Where a concept has no data yet, the row says so and
§6 decides it.

| Auth0 concept | Here today | Store |
|---|---|---|
| Tenant | The issuer (one per install) | `settings.ts`, env-spec keys |
| Application (client) | Applications | `oauth_client` (oauthProvider) + our edit/disable verbs |
| Application `app_type` | "machine" vs sign-in client (#2267) | grant types on `oauth_client` |
| API (resource server) | Platform MCP resources, invisible in the console | `oauth_resource` (`resources.ts`) |
| Client grant (app → API, scopes) | `MACHINE_SCOPES`, issuer-wide only | env-spec key |
| Connection (database) | Email + password, `ALLOW_SIGNUP` on Access | Better Auth `emailAndPassword` |
| Connection (social / enterprise) | Sign-in providers, catalogue and custom OIDC | our provider registry (`providers.ts`) |
| Connection (BankID, phone) | BankID screen; SMS second factor | `bankid.ts`, `phone-plugin.ts` |
| Client ↔ connection enablement | Per-client sign-in methods | client `metadata.signIn` |
| User + identities | Users + sign-in methods | `user`, `account` |
| User sessions | User detail → Sessions | `session` |
| Branding / theme | Per-client theme only | client `metadata.theme` (`branding.ts`) |
| Email templates | Fixed, in code | `email.ts` |
| Logs | Sign-in log | `sign-in-log.ts` |
| Signing keys | Not shown | `jwks` (jwt plugin) |
| Roles, permissions, organizations | No equivalent | none (§6) |

**Connections are the biggest change.** Auth0's one idea, "a source of identities that
applications are enabled for", replaces three things that grew separately:
- the Sign-in providers screen,
- the BankID screen,
- the password half of Access.

Each connection gets a **strategy** (`database`, `google-oauth2`, `github`, `oidc`,
`bankid`, `sms`, …) and an **Applications** tab listing which clients are enabled for it.

That tab is another view of the per-client `metadata.signIn` policy, not new storage. Toggling a client on a connection
rewrites that client's `signIn` through the same PATCH. Absent `signIn` reads as "enabled for
every connection", which keeps the "absent means everything" rule concept.md states. The
enforcement point stays the before-hook on `/oauth2/authorize`. Reserved ids (`password`,
`bankid`) become the database and BankID connections' own ids, so the reservation reads as
what it is.

## 3. Information architecture

Group order follows Auth0's dashboard (which AuthHero mirrors), trimmed to what exists:

| Group | Item | Path | Replaces |
|---|---|---|---|
| — | Overview | `/` | the `/` redirect |
| Applications | Applications | `/applications` | same |
| Applications | APIs | `/apis` | new view over `oauth_resource` and machine scopes |
| Authentication | Connections | `/connections` | Sign-in providers, BankID, password half of Access |
| Authentication | Security | `/security` | Access (sign-up), SMS factor, account-linking mode |
| User management | Users | `/users` | same |
| Branding | Universal Login | `/branding` | per-client Appearance + a new issuer default |
| Branding | Emails | `/emails` | new: reset / verification / invitation templates |
| Monitoring | Logs | `/logs` | Sign-in log |
| — | Settings | `/settings` | Issuer, plus keys, import/export |
| (footer menu) | Your account | `/account` | same |

**Overview** is Auth0's landing page and the dashboard's. It shows:
- sign-ins over the last 7 / 30 days, succeeded vs failed, from the sign-in log,
- active users,
- the three most recent failures, each linked to its log entry,
- a "get started" card while the issuer has only the seeded client.

A non-administrator still sees only *Your account*, which is the nav courtesy console-ia.md
describes. The server-side `admin` gate is unchanged.

### Detail screens: a header and tabs

Every detail screen is a `DetailHeader` (icon, name, kind, id with a copy button, status pill,
primary action, overflow menu) over `Tabs`. The tab is in the URL (`/applications/<id>/connections`),
so a tab survives a reload and can be pasted into a support conversation, the same argument
console-ia.md makes for detail URLs. The strict parsers in `paths.ts` grow one optional segment
per screen, from a fixed list, and `returnTarget()` admits exactly those.

Each screen ends with a **Raw** tab, the record as JSON with secrets elided. AuthHero puts one
on every screen, and it is the cheapest way to answer "what is actually stored".

| Screen | Tabs |
|---|---|
| Application | Settings · Connections · Branding · API access · Logs · Raw |
| API | Settings · Scopes · Machine access · Raw |
| Connection | Settings · Applications · (database: Password policy) · Try · Raw |
| User | Details · Identities · Sessions · Logs · Raw |
| Log entry | Details · Raw |
| Settings | General · Signing keys · Import / export · Advanced |

**Try** on a connection runs a real round-trip against the upstream in a popup and shows the
claims that came back. Today an operator finds a misconfigured upstream by signing in for real
and then reading the log. Try gives the same answer before any user hits it.

## 4. The management API: `/api/v2`, Auth0-shaped

Today the console calls three kinds of endpoint:
- `/api/admin/*`: settings, providers, bankid, clients, sign-in methods, import, sign-in log,
- Better Auth's own `/api/auth/admin/*` for users,
- a few one-offs.

All of them sit behind the console's session cookie. Nothing outside a browser can automate
this issuer. A platform that provisions issuers (the dashboard binding verticals to one) uses
`/internal/configure` on the platform credential, which no tenant holds.

**Proposal: one management API at `/api/v2`, in Auth0's shape, which the console itself uses.**

| Resource | Verbs | Backs onto |
|---|---|---|
| `/users` | GET (q, page), POST, GET/PATCH/DELETE `/:id` | admin plugin + ours |
| `/users/:id/identities` | GET, DELETE `/:provider/:id` | today's sign-in-methods routes |
| `/users/:id/sessions` | GET, DELETE | admin plugin |
| `/users/import` | POST (dry run, merge) | `user-import.ts` |
| `/clients` | GET, POST, GET/PATCH/DELETE `/:client_id` | today's `/api/admin/clients` |
| `/clients/:id/rotate-secret` | POST | plugin |
| `/clients/:id/connections` | GET, PUT (whole ordered list) | `metadata.signIn` |
| `/connections` | GET, POST, GET/PATCH/DELETE `/:id` | provider registry, BankID, database |
| `/connections/:id/clients` | GET, PATCH | `metadata.signIn` (inverse view) |
| `/resource-servers` | GET, POST, PATCH, DELETE | `oauth_resource` |
| `/branding` · `/email-templates/:name` | GET, PATCH / PUT | new (§6) |
| `/logs` · `/logs/:id` | GET (q, from/take) | sign-in log |
| `/keys/signing` | GET, POST `/rotate` | jwt plugin |
| `/tenants/settings` | GET, PATCH | `settings.ts` |

**Conventions:** AuthHero's, which are Auth0's.
- **Paging.** `page` (0-based) + `per_page` (default 50). `include_totals=true` returns the
  envelope `{start, limit, length, total, <items>}`. Logs page by checkpoint instead:
  `from` / `take` returns `{logs, next}`.
- **Search.** `q=` takes a field-scoped subset (`email:`, `name:`, `user_id:`, `type:`,
  `client_id:`), parsed into bound SQL parameters and never concatenated. Keep the pattern
  limits CLAUDE.md states for Durable Object SQL.
- **Updates.** PATCH updates an entity. PUT replaces a whole document (an ordered connection
  list, an email template).
- **Errors.** Management errors are `{statusCode, error, message, errorCode}`. OAuth endpoints
  keep RFC 6749's `{error, error_description}`.

**Authentication.**
- **Machines.** A bearer token from this issuer's own `client_credentials` grant, with
  `audience = {issuer}/api/v2/` and Auth0's scope names (`read:users`, `update:clients`,
  `read:logs`, …). The issuer registers `/api/v2/` as a resource of itself. A machine
  application is granted management scopes on the new **API access** tab, never through
  `MACHINE_SCOPES`, which stays the ceiling for *other* APIs.
- **The console.** It keeps its session cookie, and `/api/v2` accepts session + `admin` as the
  equivalent of every management scope. This is one middleware with two credential readers,
  not two APIs.
- **Origin rule.** A cookie-authenticated mutation is refused unless it comes from the
  issuer's own origin. `/api/admin` has no such check of its own today (`src/routes.ts`
  forwards it to the DO unchanged), so Phase 3 adds the rule and tests it rather than
  inheriting it.

`/api/admin/*` stays for one release as a thin alias. It is removed once nothing in the
repo calls it. The OpenAPI document for `/api/v2` is emitted and
gated like every other generated artifact (CLAUDE.md, three marks), and the `postman/`
collection is regenerated from it.

**Compatibility target: Auth0's shape, not certification.** The aim is that a Terraform or
go-auth0 user recognises the surface, and that the common reads parse. Claiming SDK
compatibility would mean running those SDKs in CI, which §6 leaves as a decision.

## 5. Logs, branding, and the sign-in pages

**Logs.** Each sign-in-log row gets an Auth0 log `type` code (`s` success login, `f` failed
login, `fp` wrong password, `ss` success signup, `fs` failed signup, `slo` logout, `seccft`
client-credentials exchange, …). The code is derived from the stored `(method, outcome, phase)`,
so no migration is needed. The list shows the code's human description. A filter chip per
type, application and connection replaces today's free fields. A log entry has its own URL,
which Overview and the Application and User "Logs" tabs link to.

**Branding.** Two levels, as in Auth0:
- an issuer-wide theme on `/branding` (logo, colours, radius, font),
- a per-client override on the Application's Branding tab, which is today's
  `metadata.theme` and its sanitiser, unchanged.

A **live preview** renders the real `/login` component with the draft theme in an iframe,
which AuthHero's `branding/preview.tsx` does. The public `client-options` read merges
issuer → client and keeps its rule: it answers nothing that could enumerate the registry.

**Sign-in pages.** They keep their paths. Inside `/login`, the flow becomes **identifier-first**
when more than one connection could own the address:

1. Ask for the email.
2. Offer what that address can actually use, filtered by the client's enabled connections.
3. Then ask for a password, BankID or the upstream.

A client enabled for exactly one connection skips step 1. These are the steps Auth0's `login-id` → `login-password` prompts take, and
AuthHero's `/u2` screens. It is the only part of the redesign that touches the relying
party's path, so it ships last and on its own.

## 6. Decisions to make before Phase 3

1. **Organizations and roles.** Auth0 has both, and Better Auth has an `organization` plugin
   that could supply members, roles and invitations. Adding it is a schema change
   (`lint:auth-schema`, and a migration diff for review). It also widens what a token can
   claim. *Recommendation:* leave both out of this redesign. Neither shows in the nav until a
   relying party needs org-scoped tokens, because a menu entry over no data is a promise.
2. **Email templates.** Making them editable means storing them, with an editor and a
   sanitiser (an HTML body sent from this domain). *Recommendation:* ship `/emails` read-only
   first (preview plus "send me a test") and make it editable in a follow-up.
3. **SDK compatibility as a gate.** Should CI run go-auth0 or the Terraform provider against
   `/api/v2`? *Recommendation:* not yet. Pin the shape with contract tests on our own
   OpenAPI document, and revisit once something outside the platform automates an issuer.
4. **Actions / hooks.** AuthHero has them; this issuer has fixed before-hooks in code.
   *Recommendation:* out of scope. Running tenant code on the sign-in path is a separate
   design.

## 7. Phases

| Phase | Delivers | Touches `src/`? |
|---|---|---|
| 1. Shell | `AppShell` and friends in `@substrat-run/ui`; dashboard moved onto them with no visual change; console on the shell with light/dark, crumbs, issuer card, account menu, lazy-loaded behind `auth/` | no |
| 2. Regroup | The new nav (§3), ⌘K jump-to, tabbed detail screens with Raw, Connections as one list over today's three stores, APIs as a read view, log type codes, Overview | log codes only |
| 3. `/api/v2` | The management API (§4), the console switched to it, OpenAPI gated, `/api/admin` aliased | yes |
| 4. Branding | Issuer-level theme, live preview, `/emails` read-only | yes |
| 5. Identifier-first | The `/login` sequence (§5) | yes, relying-party path |

Phases 1 and 2 are console-only: they change no route, no stored row and no permission, so a
reviewer reads them as UI diffs. Phase 3 is the first that adds an authenticated surface, and
it carries the security review: the scope-to-route table, the cookie origin rule, and a test
that a token minted for another audience is refused.
