---
"@substrat-run/kernel": minor
"@substrat-run/adapter-cloudflare": minor
"@substrat-run/adapter-sqlite": minor
"@substrat-run/connector-scrive": patch
"@substrat-run/connector-fortnox": patch
"@substrat-run/connector-planima": patch
"@substrat-run/connector-microsoft365": patch
---

A streamed connector response body now times out on idleness, not on total transfer time (#2518). A connection's `fetch` used to hold one `timeoutMs` deadline (default 30 s) over the whole exchange, so a streamed provider file had to arrive in full within it however fast its bytes were flowing, and a large file on a slow link could never land. Now `timeoutMs` bounds the call up to the response headers and any buffered read (`text()`, `json()`, `arrayBuffer()`), as before. Once the body is read as a stream (looking at `body`, or taking it and never reading, releases nothing) that deadline hands over to two limits: the stream errors when the provider sends no byte for `STREAM_IDLE_TIMEOUT_MS` (30 s; an empty chunk is not a byte, and a source that makes no progress, a thousand empty chunks in a row, errors the stream too), and 10 minutes after its first read (`STREAM_MAX_DURATION_MS`) however steadily it flows. A transfer that keeps flowing completes; a stalled or endless one errors with the same `TimeoutError`, the connection is released, and an upload reading it lands no object and no row.

The kernel exports `deadlineFetch(fetch, timeoutMs, { idleMs, maxStreamMs })` and the two constants. Both hosts wrap the connection `fetch` in it, and take an optional `streamIdleTimeoutMs` so a test can use a short window. The Scrive, Fortnox, Planima and Microsoft 365 connectors use it for their own timed `fetch` in place of `AbortSignal.timeout`.
