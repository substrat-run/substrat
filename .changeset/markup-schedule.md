---
"@substrat-run/contracts": minor
"@substrat-run/kernel": minor
"@substrat-run/adapter-sqlite": minor
"@substrat-run/adapter-cloudflare": minor
"@substrat-run/contract-tests": minor
"@substrat-run/control-plane-api": minor
"@substrat-run/builder": patch
"@substrat-run/control-plane": patch
"@substrat-run/docs": patch
---

The markup schedule (#3316): what a tenant is charged over cost is now data in the control plane, a default plus dated overrides per tenant, billed dimension and kind, set by staff and recorded in the admin log. Prices are computed at read with the decimal helpers; the model ledger and the builder studio price model calls from it, at today's 30%.
