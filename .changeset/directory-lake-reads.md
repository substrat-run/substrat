---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane': patch
---

The admin log and a tenant's export can read history before the directory's 35-day window from the lake (K-70), behind a switch that is off by default and has a compare mode; a staff read of the lake's directory table is recorded in the access log.
