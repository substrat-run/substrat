---
'@substrat-run/contracts': minor
'@substrat-run/control-plane-api': patch
'@substrat-run/cli': patch
---

One reading of a failed control-plane response. `problemDetail` in `@substrat-run/contracts`
reads the sentence a failure carried — the RFC 9457 `detail`, the deprecated `error`
duplicate, a relayed `message`, then the stable `title` — and answers `undefined` rather
than a fabricated one, so the caller keeps its own fallback. The four clients that each
restated that fallback now share it; the one that read the deprecated duplicate alone no
longer shows a status line in place of the reason a request was refused.
