---
'@substrat-run/oidc-rp': minor
'@substrat-run/control-plane': minor
'@substrat-run/cli': minor
---

Account switching actually works: force past the IdP SSO cookie and the browser session.

Before this, "sign in as a different account" was impossible: `/api/auth/logout` only
cleared the app's own `sb_session` cookie, the IdP's SSO cookie survived, and the next
authorize round-trip silently re-authenticated the old user — no typed email could win.
The CLI broker added a second layer: `substrat login` reused any live browser session
without ever showing a login screen.

**oidc-rp**: `/api/auth/login` now passes through an allowlisted `prompt`
(`login` | `select_account`) so the IdP re-prompts past its SSO session, and
`/api/auth/logout?federated` chains through the issuer's `end_session_endpoint`
(RP-initiated logout, discovery-driven; local-only remains the default so other apps
on the shared IdP session keep theirs).

**control-plane**: the CLI login broker accepts `fresh=1` — it skips the live browser
session and bounces through `/api/auth/login?prompt=login`, stripping `fresh` from the
returnTo so the post-login bounce uses the new session instead of looping.

**cli**: `substrat login --fresh` requests exactly that flow, and
`substrat workspaces` lists your workspaces (an alias of `whoami`).
