---
"@substrat-run/contracts": minor
"@substrat-run/kernel": minor
"@substrat-run/adapter-sqlite": minor
"@substrat-run/adapter-cloudflare": minor
"@substrat-run/contract-tests": minor
"@substrat-run/control-plane-api": minor
---

Meter 3, for model usage (#1054, step 3). A vertical's model host raises each `ModelUsageLine` as a `model-usage` platform intent; the control plane's drain records it in the directory's `_substrat_model_usage` ledger, idempotent on the intent id (a replayed drain writes nothing twice) and refusing a line attributed to any tenant, scope or vertical other than the one being drained. `HostAdmin` gains `recordModelUsage`, `listModelUsage` and `summarizeModelUsage`; the fold (`foldModelUsage`) is the kernel's, so both adapters quote one number — list price summed exactly, the platform's margin (`MODEL_MARGIN_PERCENT`, default 20, applied at read time) beside it, unpriced calls counted rather than folded in as $0. `GET /model-usage` and `GET /model-usage/summary` serve it; the console's Meters view shows it beside meters 1 and 2.
