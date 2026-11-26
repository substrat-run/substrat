---
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/control-plane': patch
---

A control-plane directory whose `_substrat_sweep_runs` table predates its `request_id` column starts again. The table's dedupe index was created before the column was added, so every start failed with "no such column: request_id" and the column never arrived. The index is now created once the columns exist.
