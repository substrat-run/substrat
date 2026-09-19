---
'@substrat-run/control-plane-api': patch
---

The `deploy refused:` refusal carries its own code, and `mapError`'s `CODE_PATTERNS` table loses its row — 21 rows to 20 (#113 phase 5). `assertSandboxContract`'s one throw site now says `substratError('forbidden', …)`, so the 403 comes from the throw's declaration rather than a regex over its prose. The message is byte-identical and the response is unchanged — same 403, same detail.

This is the first family whose throw is not in an adapter: it lives in this package, on the coordinator, with no Durable Object hop to fold its `name` into the message. An untyped `deploy refused:` sentence now falls through to the generic 500, which is the point, and the sandbox-contract unit cases assert the code on every refusal branch rather than the sentence alone.
