---
'@substrat-run/adapter-sqlite': patch
---

The nine `unknown vertical '…'` refusals in the admin surface are thrown as `substratError('not_found', …)` rather than a bare `Error` (#113 phase 5) — the same nine sites the Cloudflare adapter carries, kept in step by the shared contract suite. The sentences are byte-identical; the refusal now carries its own code. No interface, migration or permission change.
