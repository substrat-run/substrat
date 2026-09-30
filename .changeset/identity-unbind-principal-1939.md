---
'@substrat-run/vertical-auth': minor
---

The identity directory adds `unbindPrincipal(scopeId, principal)`, which removes all subject bindings for a principal in one scope and returns the removed subjects. Member removal can now avoid a capped scope-wide scan that might miss a second login. The directory indexes scope and principal for this operation; callers can use the returned subjects to report each absent place to their identity issuer.
