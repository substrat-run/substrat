---
'@substrat-run/engine-absence': patch
'@substrat-run/engine-booking': patch
'@substrat-run/engine-invites': patch
'@substrat-run/engine-invoicing': patch
'@substrat-run/engine-metering': patch
'@substrat-run/engine-protocol': patch
'@substrat-run/engine-workorder': patch
---

Every engine's handler map is now bound to its declared operations with `satisfies OperationImpl<typeof ops, OperationContext>` instead of cast, so a handler that returns something other than its declared output, or needs more input than the host parses, no longer compiles. Runtime behaviour, manifests and the published operation surfaces are unchanged.
