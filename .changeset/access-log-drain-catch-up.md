---
'@substrat-run/kernel': patch
'@substrat-run/control-plane': patch
---

The access-log drain keeps going while a batch comes back full, up to eight batches a pass, so a backlog closes instead of growing (#3326).
