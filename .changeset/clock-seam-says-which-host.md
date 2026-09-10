---
'@substrat-run/kernel': patch
'@substrat-run/adapter-cloudflare': patch
---

The clock seam says which host honours it. `OperationContext.now()` and the `Clock`
interface described a host-injectable clock without qualification, while
`CloudflareScopeHostOptions` declares `clock?: never` — so the kernel, where a builder
reads the contract, promised a seam one of the two hosts refuses. Both docblocks now
name the pure host as the one that honours it, why the Durable-Object host cannot, and
what that costs (expiry transitions asserted on the SQLite host only). Comments and docs
only; no behaviour change.
