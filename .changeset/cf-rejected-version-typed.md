---
'@substrat-run/adapter-cloudflare': patch
---

`admitVersion`'s refusal of a rejected version — `version … was rejected — publish a new one` — is thrown as `substratError('conflict', …)` rather than a bare `Error` (#113 phase 5). The sentence is byte-identical; what changes is that the refusal now carries its own code, so a transport renders the 409 from the declaration instead of a caller recognising the message. It is thrown on the COORDINATOR, not inside a Durable Object, which is what makes this possible today. No interface, migration or permission change.
