---
'@substrat-run/adapter-cloudflare': patch
---

Three of the registry's refusals are thrown as `substratError('conflict', …)` rather than a bare `Error` (#113 phase 5): `registerVertical` refusing a slug under a different owner (`vertical … is owned by …`), `setVerticalListed` refusing a prod version only the auto-admission note vouches for (`… is auto-admitted (private self-serve) …`), and `bindScopeVersion` / `promoteVersion` refusing a version that is not admitted (`… not admitted — it cannot be bound to a scope` / `… promoted`). The sentences are byte-identical; each refusal now carries its own code, so a transport renders the 409 from the declaration instead of a caller recognising the message. All four sites are thrown on the COORDINATOR, in Worker code, never inside a Durable Object, which is what makes this possible today. No interface, migration or permission change.
