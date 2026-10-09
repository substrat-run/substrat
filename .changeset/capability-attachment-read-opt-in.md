---
"@substrat-run/contracts": minor
"@substrat-run/kernel": minor
"@substrat-run/contract-tests": patch
---

Add a separate `attachments: 'read'` capability mint field for attachment list, open and search. Existing operation allowlists retain their meaning. Existing capability rows read the nullable attachment opt-in as absent after the additive spine upgrade; no rows are backfilled. Attachment reads still check the target's read key as the capability.
