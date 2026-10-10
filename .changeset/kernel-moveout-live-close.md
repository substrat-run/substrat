---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/demo-ticket0': patch
'@substrat-run/docs': patch
---

**Breaking:** the kernel no longer exports the live-socket close codes or the socket cap (part of #1978).

- `LIVE_CLOSE` is now defined in `@substrat-run/contracts`, and in its zero-import `./wire-headers` subpath beside `LIVE_MODE_HEADER` and `LiveRefusal`. A browser bundle can import the close codes without the rest of the package. The kernel no longer exports it; import it from `@substrat-run/contracts` instead.
- `LIVE_SOCKETS_PER_PRINCIPAL` is the hosted adapter's own limit, and now lives in `@substrat-run/adapter-cloudflare`. The kernel no longer exports it. The limit is unchanged: 8 sockets per principal per scope.
- ticket0's desk app reads the close code from `@substrat-run/contracts/wire-headers` instead of keeping its own copy of `4429`.
