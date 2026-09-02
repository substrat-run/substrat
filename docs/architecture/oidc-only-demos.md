---
status: built
layer: plan
description: Remove the credential store from the verticals.
---

# OIDC-only demos: remove the credential store from the verticals

**Status:** **built** — every demo vertical is OIDC-only
**Scope:** `demos/meridian`, `demos/manyfold`, `demos/callout`; later `demos/todo`,
`demos/ticket0`, `demos/shop`, `demos/handlebar`, `demos/rally`
**Author:** design pass, 2026-08-04 · shop, handlebar and rally added 2026-09-01

## Motivation

Verticals should not run their own credential store. Three demos each carry a per-tenant
`IdentityDO` running **Better Auth** (signup, password, reset) over its own SQLite, plus a
builtin/oidc `auth-mode` split and email/password UI. That's auth we build and maintain
inside every app. Credentials belong to the issuer — **`demos/auth-server`** (a Better
Auth OIDC issuer). After this change, Better Auth lives only there.

## The key distinction (what stays vs what goes)

The `IdentityDO` does two unrelated jobs. Only one is "auth":

| Layer | What it is | Fate |
|---|---|---|
| **Credentials** — Better Auth store, signup, password, reset, email/password UI | The "internal auth" to remove | **Remove** — the issuer owns it |
| **`sub → principal` binding** — first-run owner-claim + invites | Provider-agnostic **authZ**; captures the OIDC `sub` at first login | **Keep** — unchanged |

**Why the binding stays.** The `sub → principal` map is keyed on the OIDC `sub`
(`resolvePrincipal(scopeId, sub)`), and that binding is **already provider-agnostic** —
`resolvePrincipal` / `claimInvite` operate on `subject.sub` no matter whether the session
came from builtin Better Auth or the OIDC-RP provider. Meridian already, in OIDC mode,
resolves principals through this binding (`worker.ts:228`) and accepts invites across the
OIDC round-trip (`AcceptInviteOidc`, `app/src/auth.tsx`).

**Why it can't be replaced by dashboard-side projection.** A brand-new member's `sub`
does not exist until they first authenticate at the app's issuer; `sub` is minted by that
issuer (`sub = Better Auth user.id`, issuer-wide-stable — `auth-do.ts:211`). The dashboard
authenticates against a *different* issuer (AuthHero) and has no admin path to resolve a
member's app-issuer `sub` ahead of first login. So a first-login binding step is
unavoidable — and that step is exactly owner-claim / invites. They are the sub-capture, not
credentials. (Full trace: earlier design iterations in git history of this file.)

## What changes, per demo

Common:
- `authProviderFor` always returns `oidcRpAuthProvider` — the **sole** credential provider.
- **Keep** the `IdentityDO` `sub → principal` binding: owner-claim + invites, untouched.
- **Delete:** the builtin Better-Auth branch in `authProviderFor`; `auth-node.ts` dev
  server; the `/api/auth-mode` builtin/oidc split (SPA always redirects to the issuer); the
  email/password sign-in/up UI. The invite-accept UI **stays**.

Per demo:
- **meridian** — already has `oidcRpAuthProvider`. Mostly deletion of the builtin path +
  collapsing `/api/auth-mode`. Invites/owner-claim untouched.
- **manyfold** — currently only has the *bearer* verifier; **add** `oidcRpAuthProvider` for
  interactive login. Keep its invites/owner-claim + site registry. Delete builtin/UI.
- **callout** — migrate off its D1 Better Auth (`AUTH_DB`, `auth.ts`, `d1IdentityDirectory`)
  onto `oidcRpAuthProvider`. Its binding today is TOFU **auto-mint** (`auth-adapters.ts:153`);
  keep an equivalent binding under OIDC (auto-mint or owner-claim — decide during build).

## Shop, added later — the storefront case

Shop was never in the original scope and turned out to need no new domain surface, so it
went over as-is. Two things about it are worth recording, because neither appears in the
three demos above.

**An anonymous principal is not a credential store.** The storefront must answer "what may
someone who has not signed in see", and it answers with `publicAuth` — a browse-only
principal that survives this change untouched. The rule is about credentials the vertical
would otherwise own, not about unauthenticated access.

**Self-service signup becomes TOFU at the seam.** Shop is the one demo where a stranger
creates their own account. Sign-up moves to the issuer; the vertical keeps the *binding*
half — first arrival of an unknown `sub` mints a principal, creates its customer, grants
entity-narrowed `order:read` on that customer, and links the identity. `dev|nykund` is in
the cast and deliberately absent from `PERSONA_PRINCIPALS`, so picking it exercises that
path rather than a pre-bound one.

That path had a latent bug the move exposed: the link was written under provider
`better-auth` while the lookup asked for `better-auth:kallkalla`, so it could never hit and
every request from a self-service shopper minted another principal and another customer
row. One provider constant on both sides is what fixes it. The provider is now named for
the POOL (`oidc:<slug>`) rather than for whatever issuer currently fills it — a string
carrying the issuer's name orphans every link in the directory the day the issuer changes.

## Handlebar, added later — the deferral resolved

Handlebar was deferred above because `/api/cast` was answering a domain question: it filled
the **mechanic dropdown** on the assign action, and there was no `whoami` for the
staff-vs-portal chrome. Both turned out to be smaller than the deferral assumed.

**The chrome half needed no new surface.** `bike-shop/whoami` is callout's operation with
handlebar's vocabulary — ungated (answering "what may I do" must work for a principal who
may do nothing), and derived by probing the caller's OWN grants through `ctx.check`. No new
permission key, so no permission-diff checkpoint. Portal is decided by EXCLUSION, which is
true whoever is asking; the persona table's `role: 'portal'` was true only locally.

**The dropdown half was already answered, by callout.** Callout hit the identical problem
and resolved it by degrading the picker to a free-text field with a note, deferring the real
list to "a members API of its own". Handlebar takes the same treatment. The dropdown was not
merely local-only — it rendered EMPTY in any hosted install, so assignment was impossible
there. A field that says what it is beats a picker that works in one environment.

So no staff table, no migration, and no new permission key: the deferral was about surface
that a second look showed nobody needed.

### An unrelated bug this surfaced

Driving handlebar's HTTP path — which the migration requires and the scenario suite does not
do — turned up `GET /api/customers` answering **400 `NotListable`** on every call. The Kunder
screen has never worked. `bike-shop/list-customers` declares `paged.over`, but the manifest
never called `listsDeclaredBy()`, so nothing carried that declaration to the kernel and the
declaration was decorative. Every other vertical and engine in the workspace already had the
line. Fixed here, because a migration that leaves a main screen broken has not been verified.

**Callout has the same gap** and is not fixed here.

## Rally, added last — the deferral was real, and cost one column

Rally was the only one of the three whose deferral held up: the player app centres on a
`memberId`, and there was genuinely no way for a signed-in player to find their own.
`rally_members.party_ref` is a `dataSubjectId` — it ties the same human's member records
together ACROSS clubs, which is a different question from "which login is this" — and
`rally/list-members` requires `manage-members`, which a player deliberately does not hold.
The dev server papered over it by shipping a hardcoded persona → member map inside
`/api/cast`, so the player app was correct here and broken anywhere else.

**The seam is one nullable column.** Migration `0003-member-principal` adds
`principal_ref` to `rally_members`, `rally/create-member` takes an optional `principalRef`
(additive, behaviour-preserving), and `rally/whoami` returns the caller's own row. It stays
nullable on purpose: a member registered at the desk for someone who has never signed in has
no principal yet, and that is a normal state rather than a value to backfill. It is the
LOGIN that is optional here, not the member.

**Resolution is per venue, and that is rally's whole shape.** Clubs are tenants, the pool is
central, and one login is legitimately a different principal — and a different member — at
each club. So this vertical uses `login.subject` plus its own
`resolveIdentity(venue.tenantId, …)`, never `login.caller`, which answers "which tenant is
this login in" by taking the first. Two routes had to learn the same lesson: `/api/my-venues`
resolved once and probed every club with that one principal, which the `x-principal` header
had made invisible because the header named a principal directly and no tenant was ever
consulted.

### Two things that got stricter on the way

`/api/invites/accept` used to take the identifier it is checked against **from the request
body** on the dev-header path. The proof now comes from the caller's own verified token and
nowhere else, so an acceptor cannot name the address they are being checked against. The
player app's "type the email you were invited as" field is gone with it — it could only ever
have been a second, ignorable answer to a question the issuer already settled.

`/api/clubs` used to call the venue-scoped resolver, which demands a principal in the
selected venue's tenant. The club directory is the one read for which that is the wrong
question: someone browsing for a club to join is by definition not in it yet. It now
requires only a valid session.

## `packages/vertical-auth`

**No package changes required.** `IdentityDO` (owner-claim/invites) is retained as-is;
`oidcRpAuthProvider` already exists. The live **Egeryds / sesamy-crm** verticals depend on
this package and are unaffected — this change only rewires the three demos.

## Local dev

OIDC-only means dev needs an issuer. The first pass kept an `x-principal` persona picker in
each demo's dev server instead — cheaper, and wrong in a way worth recording: it left every
vertical carrying an impersonation header, a persona table, and an SPA that branched on
which backend answered, so the login a developer exercised all day was the one no deployment
ran.

**Callout is now issuer-only** (`packages/dev-issuer`). The dev issuer is a genuine OP —
discovery, JWKS, Authorization Code + PKCE, signed ID token — whose single shortcut is that
`/authorize` renders a list of names rather than a password field. It is stateless (the
authorization code is a short-lived JWT; there is no session store and therefore no SSO
cookie, which is why the picker appears on every `/authorize` and switching user is one
click). Its signing key is checked in and public, which is exactly why it must never be
deployed and why nothing but a loopback relying party may trust it.

What that buys, beyond ergonomics: the vertical holds ONE auth path. `demos/auth-server`
remains the full Better Auth issuer for exercising real accounts, sign-up and password
reset; the dev issuer is for the other 95% of local work.

**Meridian, Manyfold and Todo followed**, each the same shape of change: a `personas.ts`,
identity links in the seed, and `devLogin` in the dev server. The `create-substrat` template
too — its worker now ships no caller resolution at all rather than a header-gated one, so a
scaffolded project has nothing to forget to turn off.

**Rally and handlebar did not, and the reason is worth recording.** Their persona cast was
not only an auth shortcut: it was also the answer to domain questions neither vertical can
answer yet.

  - Handlebar's mechanic picker and Callout's technician picker were both filled from the
    cast, so neither works in a hosted install today — and handlebar has no `whoami`
    operation, so even the staff-vs-portal chrome had nowhere else to come from.
  - Rally's player app centres on `memberId`, which the cast supplied per venue.
    `rally_members.party_ref` is a `dataSubjectId`, not a principal, so there is no
    principal → member seam in the vertical's own data; `rally/list-members` needs
    `manageMembers`, which a player deliberately does not hold.

Removing the cast from those two therefore means designing a "who am I here" operation
first — new surface, and a permission-diff checkpoint with it. That is a vertical-design
change wearing an auth change's clothes, and it belongs in its own PR.

## What gets deleted

| Item | Where |
|---|---|
| Better-Auth builtin branch in `authProviderFor` | each demo worker |
| `auth-node.ts` dev Better-Auth server | each demo |
| `/api/auth-mode` split + SPA builtin/oidc probe | each demo worker + app |
| Email/password sign-in/up UI (invite-accept UI stays) | each demo `app/` |
| callout D1 `AUTH_DB` Better Auth (`auth.ts`, `d1IdentityDirectory`) | callout |

**Retained:** `IdentityDO` owner-claim + invites (the sub-binding); `oidcRpAuthProvider`;
the whole `vertical-auth` package.

## Human checkpoints

- **Permission diff:** none expected (no new permission keys / role changes). Run
  `pnpm lint:permissions --check` to confirm no drift.
- **Migration diff:** none expected (no `SqlMigration[]` changes). Confirm during build.

## Risks

1. **DX** — every demo now needs a running issuer for local dev; the dev-script change is the
   largest surface. Validate by actually driving each demo.
2. **callout binding** — its auto-mint must be preserved (or swapped to owner-claim) under
   OIDC, or callout logins won't resolve to a principal.
3. **manyfold** — gains an interactive RP provider it didn't have; confirm the site registry
   (`x-site`/`resolveSiteScope`) composes with the RP login flow.

## PR breakdown

1. **meridian** — reference conversion; drive end-to-end against a local auth-server.
2. **manyfold** — add RP provider, convert.
3. **callout** — off D1 Better Auth, preserve binding.
4. **dev + docs** — dev-script issuer wiring, `CLAUDE.md` command updates.

Each demo PR is independently reviewable and testable.
