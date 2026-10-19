---
"@substrat-run/contracts": patch
"@substrat-run/cli": patch
---

A Python store-driver release may carry `python_modules/<path>` beside its one `driver_` package. The upload sends those as Data modules, and the release sha256 covers them. The source commit vouches for the driver package and the pyproject/lock it was installed from; `python_modules/` is install output, so `substrat store-driver upload` does not hold it to the commit, skips the two markers `pywrangler sync` writes there, and says the sha256 alone vouches for those bytes. The workers runtime SDK stays out of the bundle: the script imports it from the runtime the upload selects.
