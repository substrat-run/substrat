---
'@substrat-run/contract-tests': patch
---

The entity-check conformance kit can drive an operation that names a second entity of the kind it narrows to (#939). `coEntities: { 'ticket0/merge': { intoConversationId: 'conversation' } }` has the kit make that entity per case and grant it the same keys as the target, so `merge`-shaped operations join the behavioural pair instead of sitting in the receipt's "not driven" table; a co-entity naming a field the schema does not have is reported rather than counted as coverage. The receipt lists every second entity the kit supplies, and says plainly that a check on it is not what the pair asserts.
