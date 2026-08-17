---
"@substrat-run/contracts": minor
---

`manifestEntities` gains `foreignRelations`, found by the first adopter.

Callout declares `{ entityType: 'protocol', parentType: 'workorder' }` — **both
engine entities, neither owned by Callout**. The protocol engine is
entity-agnostic, so only the vertical knows that protocols hang off work orders,
and it is the vertical that must declare the permission-walk edge.

`manifestEntities` assumed every referenced entity was locally declared, which no
real vertical satisfies. Rather than widen `parent` to accept any string —
making the checked case indistinguishable from the unchecked one — foreign edges
get their own field, so they read as a short list of what is *not* yet verified.
They become checkable when engines export their entity-type constants (#696 item
3), at which point the field takes those constants instead of `string`.

This is what adoption is for: the spike could not have found it, because the
spike had no engines.
