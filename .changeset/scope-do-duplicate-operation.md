---
'@substrat-run/adapter-cloudflare': patch
---

A `defineScopeDO` class now refuses an operation name that two registrations both bind, with `operation already defined: <name>` when the object starts. The coordinator and the pure host already refused it; the Durable Object let the second registration replace the first without a word. A worker that registers the same module list on its `CloudflareScopeHost` is unaffected, since the coordinator refuses a repeat there already. A worker whose `defineScopeDO` list differs from its coordinator's and repeats a name would now fail at construction, with that message.
