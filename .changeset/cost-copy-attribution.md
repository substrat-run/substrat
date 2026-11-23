---
"@substrat-run/contracts": minor
"@substrat-run/kernel": minor
"@substrat-run/control-plane": patch
---

A preview's Cloudflare cost now reaches the team whose preview it is, back to the first day the cost rollup holds (#3353). A preview script copies data only through the directory's copy ledger, which records each copy before its data is written and outlives the script, so an object in a reaped preview script is charged to the one team the ledger names for it, as the new `copy` attribution. Rows the rollup stored without a team are attributed the same way with the next day it records. A script whose copies belong to more than one team, and a live script, stay unattributed, and a recorded object id still takes over.
