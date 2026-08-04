---
'@substrat-run/demo-meridian': minor
'@substrat-run/demo-manyfold': minor
'@substrat-run/demo-callout': minor
---

Demos are OIDC-only: remove the built-in credential store from the verticals

Meridian, Manyfold, and Callout no longer run their own Better Auth credential
store. They are pure OIDC relying parties — login, sign-up, password, and reset
all live at the OIDC issuer (`demos/auth-server`). The vertical only maps the
authenticated `sub` → a scope principal, and that binding (first-run owner-claim
+ invites in the per-tenant `IdentityDO`) is kept: it is provider-agnostic authZ,
not credentials.

- **meridian** — `oidcRpAuthProvider` is the sole provider; the builtin branch,
  `/api/auth-mode` split, first-run sign-up gate, dev Better-Auth store, and the
  email/password SPA are removed. Dev authenticates with the `x-principal` persona
  picker.
- **manyfold** — gains `oidcRpAuthProvider` (it had only the bearer verifier),
  async `authProviderFor` reading the delivered `substrat:auth`; builtin removed;
  the site registry is preserved; dev on a default persona.
- **callout** — converged onto the sandbox-clean `IdentityDO` shape: dropped the
  shared `AUTH_DB` D1 binding and Better Auth, adopted the `IdentityDO` +
  `oidcRpAuthProvider`, and replaced the TOFU auto-mint with owner-claim + invites.

`packages/vertical-auth` is unchanged, so the production verticals that depend on
it are unaffected. Better Auth now lives only in `demos/auth-server` (the issuer)
and the Node-only demos (shop/rally/handlebar). Design: `docs/design/oidc-only-demos.md`.
