---
'@substrat-run/demo-auth-server': minor
'@substrat-run/demo-auth-server-app': minor
'@substrat-run/oidc-rp': minor
'@substrat-run/vertical-auth': minor
---

Invite links open sign-up with the address filled in (#3345).
- `@substrat-run/demo-auth-server`: `prompt=create` and `screen_hint=signup` open "Create account", and the request now resumes to the application after sign-up or sign-in instead of returning to sign-up.
- `@substrat-run/demo-auth-server-app`: `login_hint` pre-fills the sign-in, identifier-first and sign-up forms. With sign-up closed, the sign-in form says so.
- `@substrat-run/oidc-rp`: `beginLogin` and `/api/auth/login` accept `prompt=create`, sent only to an issuer that advertises it, with `screen_hint=signup`.
- `@substrat-run/vertical-auth`: `mountMemberInvites` hands `send` a `signInUrl` for the invite mail, and `/api/auth/login` forwards `prompt=create`.
