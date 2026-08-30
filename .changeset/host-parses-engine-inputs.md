---
'@substrat-run/engine-workorder': patch
'@substrat-run/engine-absence': patch
'@substrat-run/engine-invoicing': patch
'@substrat-run/engine-protocol': patch
---

The workorder, absence, invoicing and protocol engines now hand the host their declared
operation inputs, so every invocation is parsed against the engine's own schemas before
the guards and the handler — on every path in, not only over HTTP. Unknown keys are
dropped and a declared field arrives with its declared type, which is what the four
engines' handlers had been assuming without checking.
