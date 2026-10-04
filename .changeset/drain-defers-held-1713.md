---
'@substrat-run/control-plane-api': patch
'@substrat-run/kernel': patch
'@substrat-run/contracts': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/vertical-host': patch
---

The rest of #1713: the platform's drain waits on a held scope, lifecycle deliveries carry the directory's revisions, and the connector doors hold too.

**The drain waits.** A hosted scope that is suspended or archived, or whose tenant is suspended or deleting, keeps its platform intents (a connector delivery the control plane runs, a sibling to provision) pending. The drain still lists them, so the backlog counts them, but runs none and settles none, so no attempt counts toward the give-up ceiling. The first drain after the scope is live again runs each one once. A held drain reports `held: true` with everything in `pending`. `PlatformDrainContext` gains a required `lifecycle: { scope, tenant }` from the directory; a scope whose tenant has no record is treated as held. `lifecycleRefusal` takes just the two statuses, so the drain and the deployment judge by one predicate.

**Revisioned deliveries.** Every lifecycle delivery carries the directory's `revision: { epoch, scope, tenant }`, and `/internal/lifecycle` refuses one without it (400). Every directory restore mints a newer `epoch` (kept out of directory dumps), so after a restore the heal pass brings each hosted scope onto what the restored directory says, in either direction: a scope its deployment ran live is held if the directory says suspended, and one it held runs again if the directory says active. A receipt now records the full revision acknowledged, not only the statuses, so a restore that left a scope's statuses unchanged still re-converges. A lifecycle a scope stored before revisions existed still holds the scope by its statuses, and any revisioned delivery replaces it.

**The connector doors hold.** On a CP-less host, `connectorInvokeLocal`, `connectorAttachmentUploadLocal` and `connectorAttachmentOpenLocal` (the far end of the platform's connector pass and dispatch) refuse a held scope in the directory's words, as every other door does.
