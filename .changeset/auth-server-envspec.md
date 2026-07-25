---
"@substrat-run/demo-auth-server": patch
---

Declare the auth-server's config surface in `package.json` `substrat.envSpec` (mirroring the
runtime `AUTH_SERVER_ENV`), so `substrat push` carries it to the registry and the dashboard
renders a settings form: `PUBLIC_ORIGIN`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` (secret),
`EMAIL_FROM`. A drift-guard test fails the build if the JSON and the TS spec ever diverge, so
the form and what the issuer actually reads can't disagree.

The Grafana-style first-admin bootstrap already existed (`ADMIN_EMAIL` + `ADMIN_PASSWORD`
seed the admin deterministically on init — no "first to sign in wins" race); this just makes
it configurable from the dashboard. No insecure `admin/admin` default — unset creds fall back
to the setup screen.
