---
'@substrat-run/connector-mail-in': patch
'@substrat-run/contracts': patch
---

A mail-in delivery claims its message, so a sweep overlapping the first attempt stores nothing twice and a killed run still counts as an attempt. The original message always uploads by the streamed route. `mailInChange` has had a `raw` kind since it was added: a handler that reads `change.index` after ruling out only `message` must now name `attachment`.
