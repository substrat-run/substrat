---
'@substrat-run/adapter-cloudflare': patch
---

The live-read surface's refusals answer RFC 9457 problem documents (`application/problem+json`) instead of `text/plain`: the coordinator's `426` (not an upgrade) and `501` (orange-to-orange, poll instead), and the scope's `403` (the subscriber may not watch the root), `404`, `426` and the three `500`s a missing or unreadable assertion raises. Every status, the `x-substrat-live` header value and the sentence (now `detail`, and `error` beside it) are unchanged; a `500` is the taxonomy's `internal` and carries no sentence. The `101` upgrades are untouched.
