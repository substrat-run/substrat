---
"@substrat-run/builder": patch
"@substrat-run/builder-workspace": minor
"@substrat-run/builder-generator": minor
---

Builder gate feedback (harness RFC H5): the tier-1 gates' verdict now reaches the model instead of dying at the UI. A red run's report (`gateReport` — failed gates with trimmed output tails; `blocked` listed as do-not-fix facts, since exit 2 means the checker crashed, not the code) persists in project state and rides into the next turn's volatile context beside the workspace brief, deleted the moment the tree goes green. After a red run, both hosts drive a capped in-turn repair loop (`gateRepairPrompt`, `MAX_GATE_REPAIRS = 2` — every attempt is a full billable model run, so the cap is a billing control): repair stops early when an attempt changes no files, never triggers on a chat-only turn over a pre-existing red tree, and repair prompts are recorded verbatim as user turns so the durable transcript stays truthful. Golden-file drift (permissions/api) gets a regenerate-don't-hand-edit hint — the diff remains the human checkpoint. Policy and wording live in `gates.ts`, above the workspace seam, so the server and the dev CLI cannot drift.
