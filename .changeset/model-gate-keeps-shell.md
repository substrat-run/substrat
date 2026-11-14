---
'@substrat-run/builder': patch
---

The studio's model gate runs again on a project with its own tsconfig: its compile no longer ends the sandbox's shell with `exit`, which failed the gate as exit 127 (SessionTerminatedError) on a model that compiled.
