---
'@substrat-run/adapter-cloudflare': patch
---

`deleteVertical`'s two bound-scope refusals are thrown as `substratError('conflict', …)` rather than a bare `Error` (#113 phase 5) — the live one ("delete or rebind them first") and the archived one ("reap or restore them first"). The sentences are byte-identical; what changes is that each refusal now carries its own code, so a transport renders the 409 from the declaration instead of recognising the prose. Both are thrown on the COORDINATOR, which is what makes this possible at all. No interface, migration or permission change.
