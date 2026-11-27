---
'@substrat-run/adapter-cloudflare': patch
---

A scope that asks for its provision reconcile after a promote now arms its own wake, so the reconcile lands within seconds even when the requests that woke it committed nothing, instead of waiting for the next scheduled pass (#3435).
