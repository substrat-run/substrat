---
'@substrat-run/control-plane-api': minor
---

The masked-export generator is exported: `maskDump`, `maskRecords`, `MASKED`,
`createPseudonymizer` and `kindOf` are now part of the package surface. The property that
matters most about a pseudonymized dump — that it still imports and still parses when a
vertical reads it back — needs the generator, an adapter and a vertical in one process,
and a vertical's own suite is the only place all three meet.
