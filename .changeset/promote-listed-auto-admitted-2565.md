---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': patch
---

A promote judges a listed vertical's prod in the unit that moves the channel (#2565).

- **The listing's rule, at promote.** `promoteVersion` refuses (`conflict`) to make an auto-admitted version a listed vertical's prod, with the sentence `setVerticalListed` refuses an auto-admitted prod with, now worded for both: `… a staff admit must vouch for it before it can be prod of a listed vertical`. A staff admit of that version lifts it, so rolling a listed vertical back to an older auto-admitted version now needs that admit first. Re-promoting the version prod already names is not refused while nothing else serves; if a different version serves (a failed serve), the retry would change what runs and is judged. Nothing already serving changes.
- **`unlistedOnly`.** `promoteVersion` takes an optional `{ unlistedOnly }`, refusing (`forbidden`) any promote of a listed vertical. The control plane's promote route passes it for a builder, and keeps its own listed check, so a builder still meets the 403 before any other gate.
- **Both read in the unit.** The vertical's `listed` and the version's admission note are read in the compare-and-set that moves the pointer, so a listing that lands while a promote is judged is seen.
- **Version skew (adapter-cloudflare).** The ControlPlaneDO's `moveChannel` is replaced by `promoteChannel`, called through `reply`. A coordinator meeting an older DO is refused (`not a replied directory method: promoteChannel`), and an older coordinator finds no `moveChannel` on the new DO. Both write nothing.
- **kernel.** `autoAdmittedProdRefusal` and `listedPromoteRefusal`, the two sentences.
- **contract-tests.** The promote cases on both adapters.
