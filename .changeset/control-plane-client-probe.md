---
'@substrat-run/control-plane-client': patch
---

A refused connect's `ControlPlaneError` now carries the provider `probe` its body named (#605), read off the same parse as the sentence. The field was declared and documented but never filled, so every caller had to re-read the body for it.
