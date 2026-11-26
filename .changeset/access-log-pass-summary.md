---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane': patch
---

The platform's own bookkeeping reads during a scheduled pass are recorded as one access-log row per pass instead of one per read (K-73, amends K-24; #3326), and the directory's access log now ships to the lake by default alongside the admin log.
