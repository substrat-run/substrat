---
'@substrat-run/contracts': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/cli': patch
---

A store driver registration may name the verticals it serves and mark its erasure pending. The graph driver serves none yet, and a subject erasure that would reach a graph store refuses (501) and keeps the key. `substrat push` refuses a vertical the driver does not serve.
