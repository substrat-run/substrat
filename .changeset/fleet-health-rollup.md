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

A read that fails answers `unknown` for every app rather than a cheerful `ok`.
