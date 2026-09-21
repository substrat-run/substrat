---
'@substrat-run/contract-tests': patch
---

The published sweep-run and model-usage contract fixtures no longer expire under retention, so the suite stops failing against an adapter once its hard-coded dates age past the 14-day and 400-day windows.
