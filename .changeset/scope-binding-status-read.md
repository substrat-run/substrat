---
'@substrat-run/contracts': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/vertical-host': minor
---

Add `listBindings` and the `/internal/connections/bindings` relay: a scope reads its own connections bound to it, with the last successful sweep and the last failed one in the platform's words.
