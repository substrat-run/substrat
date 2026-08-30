---
'@substrat-run/contracts': patch
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/contract-tests': patch
---

An expiry written with a UTC offset no longer outlives itself. `Instant` accepts an
offset on the wire and now normalises it to the equivalent `Z` text at the parse, so
the lexicographic comparison every expiry check uses agrees with chronological order —
a grant that expired an hour ago is refused whichever zone it was written in.
