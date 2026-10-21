---
'@substrat-run/contracts': minor
'@substrat-run/cli': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/docs': patch
---

Carry each loaded module's permission and owner-grant declarations in the deploy manifest. At publish, the control plane derives the registry's key rows from those declarations and refuses disagreements in keys, descriptions, declaring modules or holder marks (#2446, step 1). Module owner grants are checked against reserved keys too.

The field is optional so manifests from older CLIs remain accepted without this consistency check. The declarations are supplied by the builder. A later step will verify known engine manifests; third-party modules remain author-asserted.
