---
'@substrat-run/adapter-sqlite': patch
---

The same three registry refusals the Cloudflare adapter now types — `vertical … is owned by …`, `… is auto-admitted (private self-serve) …` and `… not admitted — it cannot be bound to a scope` / `… promoted` — are thrown as `substratError('conflict', …)` rather than a bare `Error` (#113 phase 5), kept in step by the shared contract suite. The sentences are byte-identical; the refusals now carry their own code. No interface, migration or permission change.
