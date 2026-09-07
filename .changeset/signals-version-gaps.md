---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': patch
---

Two follow-ups on the version stamp (#1242). The `SUBSTRAT_` binding namespace
is now refused at push by name, whatever type it claims — a vertical that could
declare `SUBSTRAT_VERSION_ID` itself would collide with the injected binding or
forge the stamp; the unforgeability the kernel-stamped envelope fields get for
free, a binding channel has to be given at the sandbox contract. And
`readHistory` surfaces the outbox `version` column on `historyEntry`
(`version: string | null`) — from the column only, never the envelope, which
stays deliberately version-free — so joining an event to the push that produced
it goes through the sanctioned read helper instead of a hand-rolled SELECT.
