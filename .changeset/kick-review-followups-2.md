---
'@substrat-run/control-plane-api': patch
'@substrat-run/control-plane': patch
'@substrat-run/router': patch
---

control-plane-api: a connector dispatch or bind waits for a sweep writing the same scope's state, so the two can no longer push it over the cap together.
control-plane: a scope record a router kick could not read is logged.
router: the kick flags are no longer handed back to the caller; the intent flag's value is an internal scope id.
