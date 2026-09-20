---
'@substrat-run/adapter-sqlite': patch
---

`deleteVertical`'s two bound-scope refusals are thrown as `substratError('conflict', …)` rather than a bare `Error` (#113 phase 5) — the same two sites the Cloudflare adapter carries, kept in step by the shared contract suite. The sentences are byte-identical; the refusal now carries its own code. No interface, migration or permission change.
