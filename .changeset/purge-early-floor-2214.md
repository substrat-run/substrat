---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/contract-tests': patch
'@substrat-run/docs': patch
---

An entity can make its trash horizon a floor as well as a deadline: `trash: { permission, purgeAfterDays, purgeEarly: false }` (#2214). The kernel then refuses the entity's `trashed: 'purges'` operation, for every caller, on an entity that is not in the trash or was trashed less than `purgeAfterDays` ago. As with the other trash refusals, it checks the operation's declared key first, so a caller without the key gets `permission_denied` and a caller with it gets `not_found`. There is no opt-out. The platform's purge sweep works as before.

`purgeEarly` is optional and defaults to `true`, which keeps today's behaviour: the purge operation is also the permanent delete a person uses to empty the trash at any time. `purgeEarly: false` without `purgeAfterDays` is refused when the model is emitted and when a module is registered. The emitted `model.json` carries `"purgeEarly": false` only when it is declared. A reader that does not know the key ignores it.

`purgeCutoffOf` is no longer exported from the kernel's index. It was added after 0.144.0 for ticket0's purge handler and has not been in any release. That handler now relies on the kernel's refusal instead of comparing dates itself.
