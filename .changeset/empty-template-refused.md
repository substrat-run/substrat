---
'@substrat-run/control-plane-api': patch
---

`/observability/tenant-logs` refuses an empty `template` with a 400 instead of reading it as no filter and returning the app's whole log (#1747).
