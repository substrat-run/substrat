---
'@substrat-run/adapter-cloudflare': patch
---

The live-read surface's refusals answer RFC 9457 problem documents (`application/problem+json`) instead of `text/plain`: the coordinator's `426` (not an upgrade) and `501` (orange-to-orange, poll instead), and the scope's `403` (the subscriber may not watch the root), `404`, `426` and the three `500`s a missing or unreadable assertion raises. Every status and the `x-substrat-live` header value are unchanged, and so is the sentence (now `detail`, and `error` beside it) except on the three `500`s: a `500` is the taxonomy's `internal`, which carries no sentence on the wire, so the DO logs it instead. The `101` upgrades are untouched.
