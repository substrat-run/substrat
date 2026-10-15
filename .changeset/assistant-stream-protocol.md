---
'@substrat-run/contracts': minor
---

Adds the assistant's stream protocol: `assistantStreamBody` and `assistantStreamEvent` (the events a chat thread is made of: user message, turn start and finish, steps, text, tool calls, approval requests, sources, provenance and budget notices), `isRestingEvent`, `ASSISTANT_STREAM_VERSION`, and `approvalDigest`, the SHA-256 an approval is bound to so the arguments of a gated write cannot change after the user agreed. Additive; nothing existing changes. A client ignores an event type or field it does not know, so later additions are not breaks.
