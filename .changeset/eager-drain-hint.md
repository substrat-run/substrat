---
'@substrat-run/kernel': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/contract-tests': minor
---

Adapters report committed platform intents to the stub minter (#458). `getScope` accepts `ScopeStubOptions` with an `onPlatformRequests(count)` observer, fired after an invoke commits having enqueued `ctx.requestPlatform` intents — never on rollback. A vertical wires it once in its stub helper to flag responses `x-substrat-platform-request` (new kernel constant `PLATFORM_REQUEST_HEADER`), so the router kick (#381) drains provisioning in seconds without per-route hand-wiring.
