---
'@substrat-run/dashboard': minor
'@substrat-run/console': minor
---

No more local sign-in screens: a signed-out visit hands straight off to the IdP.

Both platform apps rendered their own branded sign-in card before redirecting to
AuthHero — an extra screen that authenticated nothing. Now the SPA redirects to
`/api/auth/login` as soon as the session check comes back empty, preserving the
intended destination via `returnTo`. The local card survives only as the
`?error=auth` retry screen (auto-redirecting after a failed round-trip would loop).

Sign-out is now always federated (`/api/auth/logout?federated`): with signed-out
visits auto-redirecting to the IdP, a logout that left the IdP's SSO cookie alive
would silently sign the user right back in. This also fixes the invite-mismatch
"sign out & continue as the invited email" path, which could previously re-login
as the wrong account.

Deploy note: each app's origin (`https://app.substrat.net/…`,
`https://console.substrat.net/…`) must be registered as an allowed logout URL on
its AuthHero client — the invite flow uses dynamic `/invite/<token>` return paths,
so a path wildcard is needed.
