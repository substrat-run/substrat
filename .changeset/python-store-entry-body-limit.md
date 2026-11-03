---
"@substrat-run/control-plane-api": patch
---

The Python store entry refuses a request with no Content-Length (411) or a declared body over 4 MiB (413) before reading it, instead of running out of memory.
