---
'@substrat-run/control-plane-api': patch
'@substrat-run/contracts': patch
---

A scope store object admits each signed envelope once: the store entry spends its nonce and refuses the same envelope again (K-59).
