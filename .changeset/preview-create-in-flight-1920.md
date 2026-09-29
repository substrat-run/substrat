---
'@substrat-run/control-plane-api': patch
'@substrat-run/cli': patch
---

A preview create no longer wipes another create for the same tag that is still forking (#1920). A second create that finds the tag's preview still `provisioning` now answers 409, says when the tag frees itself, and says that `refresh` (`substrat preview create --refresh`) replaces it now, stopping a create that is still running. A create that failed tries to mark its own leftover on the way out, so the retry after it normally re-forks at once as before. A leftover nobody marked — from a create that died without answering, or one whose mark itself failed — is reaped once it is 15 minutes old. `refresh` still replaces whatever is there. `substrat preview create`, when a retried create gets that 409, adds that the earlier attempt most likely died and that `--refresh` reclaims the tag now.
