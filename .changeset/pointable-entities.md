---
'@substrat-run/contracts': minor
---

Only a **pointable** entity can be pointed at: the compiler now refuses a
composite-keyed entity where the platform needs one id.

#804 made a table's identity declarable, so `primaryKey: ['customer_id', 'year',
'month']` is now a legal entity. But an `EntityRef` is one type and one **id** —
attachments hang off one, grants narrow to one, `ctx.link` joins two, and an
event is about one and names the single output field carrying its id. None of
that has a meaning for a table identified by three columns.

Nothing refused it. Both of these compiled clean:

```ts
manifestEntities(entities, {
  attachmentTargets: [{ entityType: 'budget', readPermission: 'x:read' }],
});                              // an attachment hanging off no id at all

emits: { entity: 'budget', entityIdFrom: 'customer_id', … }
                                 // the event is about a THIRD of a row
```

That is the same silence #804 was about, one layer up — and worse, because the
consequences are a misrouted grant and an ambiguous audit subject rather than a
schema that merely accepts duplicates. Six positions now refuse it at compile
time: `parents`, `attachmentTargets.entityType`, both ends of `relations`,
`emits.entity`, and a narrowed `permission.entity`.

```
Type '"budget"' is not assignable to type '"customer" | "ext"'.
```

**Derived, not declared.** Un-pointable *is* "the primary key has more than one
column". A `pointable: true` flag would describe a second time what `primaryKey`
already says, and two descriptions of one fact are how they come to disagree.

**A single-column key that is not `id` stays fully pointable** — `primaryKey:
['workorder_id']` is one id, just not spelled `id`, so the side table keyed by an
engine's id keeps attachments, grants, links and events. Only composite keys are
excluded, and such a table is still a complete model member: migrations, a row
type, a place in `model.json`. It is simply not a grant target.

## The inference change

`defineEntities` is now `const`-generic. It has to be: without it a tuple widens
to an array, the length is lost, and the check cannot be written at all. This
affects **inference only** — the function still returns its argument unchanged,
and nothing about runtime behaviour moves. Every field of a declaration becomes
literal and readonly as a result, not just `primaryKey`, so code that assigned a
declared `parents` or `key` to a mutable array type may need a `readonly`. All 54
workspace packages typecheck unchanged; consumers outside this repo are the
reason this is a minor rather than a patch.

## Why the types are written the ugly way

The mapped type is **inlined at each of the six positions** rather than used
through the exported `PointableName` alias. TypeScript prints an alias
unresolved, so an aliased parameter reports the entire entity map instead of the
names — the #705 lesson, re-verified here. Inlined, the diagnostic lists the
entities you may actually use.

Each copy has a `@ts-expect-error` case in `test/model.test.ts`. That is the
guard against a copy drifting: delete any one narrowing and its directive turns
unused, which fails `typecheck` — verified by doing exactly that.
