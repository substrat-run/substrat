---
'create-substrat': patch
---

The scaffold's agent documentation catches up with the platform it describes: the coverage
map names all seven engines (`engine-absence` and `engine-metering` were missing, so an
agent would have quoted a build estimate for leave handling and usage metering that already
exist), the module section stops telling handlers to hand-parse their input when the
starter's own module passes `operationInputsOf` to the host, and both `AGENTS.md` and the
playbook now carry the rule that catching an engine error requires `ctx.atomic` — the one
rule whose absence lets a caught failure commit the partial writes an engine's invariants
were protecting.
