---
'@substrat-run/adapter-cloudflare': patch
---

The five `unknown version …` refusals in the admin surface are thrown as `substratError('not_found', …)` rather than a bare `Error` (#113 phase 5) — `admitVersion`, `rejectVersion`, `promoteVersion`, `bindScopeVersion` and `versionManifest`, each a null check after a registry read. The sentences are byte-identical; what changes is that the refusal now carries its own code, so a transport renders the 404 from the declaration instead of a caller recognising the message. All five are thrown on the COORDINATOR, which is what makes this possible: a throw raised inside a Durable Object arrives with its `name` folded into the message and its code gone, so the families that throw there cannot follow yet. No interface, migration or permission change.
