---
'@substrat-run/demo-auth-server': minor
---

Sign in with BankID, enabled from the dashboard. The issuer drives BankID's RP API v6.0
itself — start an order, serve the animated QR (computed server-side, pinned to BankID's
documented HMAC example) or the same-device autostart link, poll `collect` — and lands the
verified personal number in an account under provider `bankid`, so signing in twice lands in
the same account. Built as a Better Auth plugin, which is what makes the admin plugin's ban
check and `oauthProvider`'s authorize-resume apply to it exactly as they do to the password
path. Configuration is a dashboard panel (environment, PEM client certificate + key,
create-accounts and disabled toggles); the Node dev server presents the PEMs directly while
a standalone worker presents an `mtls_certificates` binding — and without one the login
screen offers no BankID button rather than a flow the worker cannot finish.
