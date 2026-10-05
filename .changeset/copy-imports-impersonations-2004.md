---
'@substrat-run/adapter-sqlite': patch
'@substrat-run/adapter-cloudflare': patch
'@substrat-run/kernel': patch
---

A copy of a scope (a fork, a snapshot or a preview) never consumes another vertical's events, even when a delivery is addressed to it directly (#2004). `deliverToPeer` into a copy now answers `paused`, with the inert-scope reason: nothing runs, nothing is journaled, and the copy's watermark stays where it was copied. The platform sweep already visited primary scopes only. This applies the same rule at the door. A host with a control-plane directory decides from the directory. A host without one decides from the scope's own copy classification.

What a copy keeps is unchanged. Its import watermarks and import journal carry over, because they describe the data the copy holds. Staff impersonation sessions were never part of a scope's data, so a copy holds none. A live session opened on the source is refused at every copy and is still honoured at the source after its own backup is restored. The kernel's `scope-copy.ts` now documents both decisions.
