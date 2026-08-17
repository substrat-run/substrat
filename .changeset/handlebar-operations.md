---
"@substrat-run/demo-handlebar": patch
---

Handlebar declares all eleven operations and binds every handler.

The second adopter of `defineOperations`, and the first that could declare its
whole surface on the first pass: every engine type it returns — `workOrder`,
`billableLine`, `protocolInstanceRow`, `money` — already has an exported schema,
so nothing here transcribes an engine's shape.

`CustomerRow` and `BikeRow` are now derived from the entity registry rather than
hand-written beside it, and `startConditionReportInput` moved next to the
declaration so the model and the handler share one object.
