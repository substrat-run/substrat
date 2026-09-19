---
'@substrat-run/adapter-cloudflare': patch
---

The nine `unknown vertical '…'` refusals in the admin surface are thrown as `substratError('not_found', …)` rather than a bare `Error` (#113 phase 5). The sentences are byte-identical; what changes is that the refusal now carries its own code, so a transport renders the 404 from the declaration instead of a caller recognising the message. No interface, migration or permission change.
