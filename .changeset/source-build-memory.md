---
'@substrat-run/control-plane-api': patch
---

A source deploy no longer keeps the submitted source in memory while the platform builds it, so a large monorepo snapshot no longer exhausts the control plane during a long build.
