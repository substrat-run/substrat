---
'@substrat-run/contracts': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane': patch
---

A `provision-tenant` request may name one of the manager's own team auth servers in `instance.signIn.issuer`. The platform then registers the new tenant's sign-in client there, delivers it as the tenant's `substrat:auth`, and lists the tenant on that auth server's account page for its members (#3202).
