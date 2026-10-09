---
"@substrat-run/kernel": minor
"@substrat-run/contract-tests": patch
---

Allow an operations-narrowed capability to opt into attachment reads with `attachments.read`. The entry does not grant a permission; each read still checks the target's read key as the capability. Existing allowlists without the entry retain their refusal.
