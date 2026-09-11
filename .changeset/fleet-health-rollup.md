---
'@substrat-run/dashboard': minor
---

The fleet rollup (#1238): a "Needs attention" panel on the Apps page answering
"is this group healthy" before any drill-down, worst first.

Composition rather than new observation — failures come from the ops-failure
record and sweep and freshness verdicts from the sweep record, both read once
for the tenant and grouped per scope, so thirty apps do not mean sixty reads.
Only apps that are not `ok` are listed, which is the right density for the
motivating user: a firm running one vertical for thirty clients gets the two
that need them, not thirty cards to scan past. A clean fleet gets one green line.

Two distinctions the rollup refuses to blur. An app no sweep has reached is
`silent`, never `ok` — nothing having checked it is not the same as nothing
being wrong with it, and rendering silence as success is the failure this whole
view set exists to prevent. And a freshness row reading `failed` is a working
sweep reporting an absence (`stale`), not a broken sweep (`failing`) — counting
it as both would let "an event is overdue" masquerade as "the machinery broke"
and lose the more specific answer.

Each row names the app and its vertical, not only its scope id: the operator this
panel is for reads it to find out WHOSE app is broken, and an opaque id makes them
open every row to find out.

A read that fails answers `unknown` for every app rather than a cheerful `ok`, and
so does a read that was TRUNCATED — the reads are bounded (this runs inside a page
paint, and a tenant-wide record has no ceiling), so each one reports whether it
reached the end of its window and the verdict degrades accordingly. "Nothing found"
is never rendered as "nothing there". The failure questions and the "has anything
checked this app at all" question get separate narrowed reads, so the broad one
running out of room costs the `silent` verdict alone and not the panel.
