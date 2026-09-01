---
"@substrat-run/docs": patch
---

The landing page leads with what you can build, not with the five things Substrat fixes

The old page opened by naming multi-tenancy, identity, permissions, audit and GDPR as
the parts that were missing — which sells a patch for a gap rather than a way to build
the whole application, and left the strongest evidence off the page entirely. Eight demo
verticals exist across eight unrelated domains, and three of them run their core domain
on the kernel alone; that set was represented by three cards near the bottom.

So the page now opens on the claim and spends the rest of itself earning it: the eight
demos first, with the kernel-only ones marked, then a new section inventorying the
twenty-three things that arrive with a project — the API and its client, identity and the
audit record, snapshots and per-PR production forks, hosting and domains — then the
single-operation code sample, the three layers, and only then the runtime guarantees,
which are proof rather than premise. The engine section is reframed to match: seven
engines you don't have to write, with the star topology drawn rather than asserted.

Two removals. The fifteen-row package table is gone — it was a reference artifact on a
marketing page, and its seven consecutive `seed` badges said something the engines page
takes a paragraph to say properly. The "honest half" is reduced to a link row, because
`/guide/what-substrat-lacks` already does that job with the shipped / built-unproven /
bet labelling the summary flattened away.

Layer colour now runs the whole page — amber for verticals, cyan for engines, indigo for
the kernel — instead of appearing as three hairlines and three dots.
