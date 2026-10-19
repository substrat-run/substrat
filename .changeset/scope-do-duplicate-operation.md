---
'@substrat-run/adapter-cloudflare': patch
---

A `defineScopeDO` class now refuses an operation name that two registrations both bind, with `operation already defined: <name>` when the object starts. The coordinator and the pure host already refused it; the Durable Object let the second registration replace the first without a word. A module list that the host accepts is unaffected, since the host registers the same list and refuses a repeat.
