---
"@substrat-run/engine-protocol": minor
---

The engine declares its entity, and exports the row schema a vertical needs.

Two things a composing vertical could not get before:

**The entity-type constant.** Callout declares `{ entityType: 'protocol',
parentType: 'workorder' }` and Handlebar `{ entityType: 'workorder', parentType:
'bike' }` — permission-walk edges naming entities the vertical does not own. Both
sides are unchecked strings today, and a typo is a silently dead edge that
permission never flows along.

**The row schema.** `output` in a declared operation (#707) is a Zod schema, so a
vertical operation returning a `ProtocolInstanceRow` would have to transcribe
this engine's shape into Zod — a description kept in agreement by nothing.
`protocolInstanceRow` removes the transcription instead of asking every vertical
to get it right. That is what blocked five of Callout's eleven operations from
declaring a return.

`ProtocolInstanceRow` is now **derived** from the registry rather than written
beside it, so the engine's own row interface and the exported schema cannot
disagree. Types only — no runtime change, no schema change.

**One entity, eight tables.** `protocol` is the only thing here the platform can
point at: attachments hang off it, grants narrow to it, verticals declare
relation edges to it. Templates, responses, signatures and signature requests are
rows this engine owns and operates on, never the subject of an `EntityRef`.

It declares **no `parent`**, and that absence is the design: the engine is
entity-agnostic, so an instance binds to whatever the vertical says and only the
vertical knows where protocols hang.

`test/entities.test.ts` holds the registry to the migration journal — the two are
descriptions of one schema until migrations are derived from the registry. Its
parser tracks paren depth so a multi-line `CHECK (...)` constraint is not read as
a column, and it asserts it parsed something before comparing.
