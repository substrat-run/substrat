---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/contract-tests': minor
---

A store driver answers the reserved `substrat.selfcheck` with the catalog its built runtime serves, and a release carries a canary fixture at `driver_<package>/substrat_canary.json`. The rollout canary imports that fixture, expects it exported back unchanged, and refuses a release whose runtime does not build over it or serves another catalog than its approval records.
