---
"@substrat-run/demo-auth-server": patch
---

feat(auth-server): implement the platform's data verbs — `/internal/export` dumps an instance in full and `/internal/delete-scope` wipes one (#590)

The standalone auth-server answered 501 to both, so the console's retire-with-backup (#493) always refused, wipes stranded storage on the script, and a data-carrying `rebindScopeVertical` could not move an install between lineages. The dump is deliberately unredacted — it exists to rebuild the issuer elsewhere, and the control-plane route in front is the gate, the auditor, and the default masker.
