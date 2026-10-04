---
'@substrat-run/control-plane-api': patch
'@substrat-run/kernel': patch
---

The platform's drain now waits on a held scope's intents (#1713). A hosted scope that is suspended or archived, or whose tenant is suspended or deleting, keeps its platform intents (a connector delivery the control plane runs, a sibling to provision) pending: the drain still lists them, so the backlog counts them, but runs none and settles none, so no attempt is counted toward the give-up ceiling. The first drain after the scope is live again runs each one once and reports it as usual; a held drain reports `held: true` with everything in `pending`.

`PlatformDrainContext` gains a required `lifecycle: { scope, tenant }`, the scope's and its tenant's status from the directory, so a caller cannot forget it. A scope whose tenant has no record is treated as held. `lifecycleRefusal` now takes just the two statuses, so the drain judges by the same predicate the deployment does.
