---
'@substrat-run/control-plane-api': patch
---

A preview create no longer wipes another create for the same tag that is still forking (#1920). A second create that finds the tag's preview still `provisioning` now answers 409, says when the tag frees itself, and says that `refresh` (`substrat preview create --refresh`) replaces it now. A create that failed marks its own leftover on the way out, so the retry after it re-forks at once as before. A leftover nobody marked, from a create that died without answering, is reaped once it is 15 minutes old. `refresh` still replaces whatever is there.
