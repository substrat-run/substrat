---
"@substrat-run/control-plane-api": patch
---

The Python store entry answers 413 to a request whose declared body is over 4 MiB, before reading it, instead of running out of memory.
