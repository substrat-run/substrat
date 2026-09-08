---
'@substrat-run/adapter-cloudflare': patch
---

State the clock seam's adapter asymmetry where a reader meets it.
`CloudflareScopeHostOptions` now declares `clock?: never` with the reason:
every elapsed-time read happens inside the ScopeDO, which workerd constructs,
so an option on the host factory cannot reach it — and an accepted-and-ignored
`clock` would read as a seam while doing nothing. No behaviour change.
