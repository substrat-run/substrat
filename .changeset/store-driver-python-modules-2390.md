---
"@substrat-run/contracts": patch
"@substrat-run/cli": patch
---

A Python store-driver release may carry `python_modules/<path>` beside its one `driver_` package. The upload sends those as Data modules, and the release sha256 covers them. The workers runtime SDK stays out of the bundle: the script imports it from the runtime the upload selects.
