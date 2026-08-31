---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

`ctx.sql` now refuses to write the platform spine. "Never write `_substrat_*`" was a
source rule only, and the source scan does not run on the hosted push path — so a
module could forge a grant, rewrite an announced event or drop the migration journal
through the same connection the kernel writes them with. Both adapters wrap their
module-facing connection in the kernel's new `guardSpine`; reads of the spine,
including the ones that feed a timeline projection, are unchanged.
