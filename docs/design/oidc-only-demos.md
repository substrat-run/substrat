# OIDC-only demos: remove the credential store from the verticals

**Status:** approved shape — implementing
**Scope:** `demos/meridian`, `demos/manyfold`, `demos/callout`
**Author:** design pass, 2026-08-04

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

## `packages/vertical-auth`

**No package changes required.** `IdentityDO` (owner-claim/invites) is retained as-is;
`oidcRpAuthProvider` already exists. The live **Egeryds / sesamy-crm** verticals depend on
this package and are unaffected — this change only rewires the three demos.

## Local dev

OIDC-only means dev needs an issuer. Each demo's dev script must run `demos/auth-server`
as the local issuer and deliver a dev `substrat:auth` pointing at it. This is the largest
DX change; validate by driving each demo end-to-end (`verify` skill).

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
