---
'@substrat-run/adapter-cloudflare': patch
---

State the clock seam's adapter asymmetry where a reader meets it.
`CloudflareScopeHostOptions` now declares `clock?: never` with the reason: the
host's elapsed-time reads sit on both sides of a boundary — impersonation-session
expiry and schedule cadence are coordinator-side, while `ctx.now()`, tuple expiry,
the system-grant check and the projected entitlement reads are inside the ScopeDO,
which workerd constructs. A clock could reach the first group and never the second,
and a partial one would carry the pure adapter's signature while disagreeing with it
on grant expiry. No behaviour change.
