---
'@substrat-run/demo-auth-server': patch
---

Register machine-to-machine (`client_credentials`) clients, gated by `MACHINE_SCOPES`. The console gains a `machine` application type: no redirect URIs, consent or sign-in policy, a secret shown once, and scopes chosen from the issuer's `MACHINE_SCOPES` list. Unset, no machine client can be registered or get a token. The token endpoint holds every request to the list as it is now, and machine scopes are never granted through a person's sign-in.
