---
'@substrat-run/kernel': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/dashboard': patch
'@substrat-run/control-plane': patch
---

An app's installs can be paid into different Stripe accounts: the landing pass binds each install to one payment connection only (`ConnectionBinder.exclusive`), and a tenant chooses which on the app's Integrations tab (`PUT /tenants/:t/scopes/:s/connections/:provider/choice`).
