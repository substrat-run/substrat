---
"@substrat-run/contracts": patch
"@substrat-run/kernel": patch
"@substrat-run/adapter-sqlite": patch
"@substrat-run/adapter-cloudflare": patch
"@substrat-run/contract-tests": patch
"@substrat-run/control-plane-api": patch
"@substrat-run/engine-booking": patch
"@substrat-run/engine-invites": patch
"@substrat-run/engine-invoicing": patch
"@substrat-run/engine-protocol": patch
"@substrat-run/engine-workorder": patch
"@substrat-run/connector-scrive": patch
"@substrat-run/cli": patch
"@substrat-run/boundary-lint": patch
"create-substrat": patch
---

docs: point every published package's `homepage` at its substrat.net page and
swap the stale `substrat.ahlstrand.es` doc links in READMEs for `substrat.net`.
Add the three missing READMEs (`engine-booking`, `cli`, `control-plane-api`).
Metadata/docs only — no code or API change; a republish is needed for the
updated README + homepage to render on npm.
