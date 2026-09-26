---
'@substrat-run/kernel': minor
'@substrat-run/engine-absence': patch
'@substrat-run/engine-booking': patch
'@substrat-run/engine-invites': patch
'@substrat-run/engine-invoicing': patch
'@substrat-run/engine-metering': patch
'@substrat-run/engine-protocol': patch
'@substrat-run/engine-workorder': patch
---

`OperationHandlersFor<typeof ops>`: the handler map a declared operation surface requires, each handler typed from its own declaration. Write a module's map as `{ … } satisfies OperationHandlersFor<typeof ops>`, and a handler that returns something other than its declared output, or needs more input than the host parses, stops compiling. Every engine's handler map is now bound this way instead of cast. Runtime behaviour, manifests and the published operation surfaces are unchanged.
