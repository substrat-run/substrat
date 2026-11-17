---
'@substrat-run/contracts': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane': patch
'@substrat-run/demo-auth-server': patch
---

A managed tenant's sign-in client is registered once at its manager's auth server, keyed by its scope, so a retried `provision-tenant` reuses it. Deleting the tenant takes it off that auth server's account pages, and reaping it removes its client there too (#3261).
