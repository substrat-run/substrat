---
'@substrat-run/contracts': minor
'@substrat-run/contract-tests': minor
'@substrat-run/demo-callout': patch
'@substrat-run/demo-handlebar': patch
'@substrat-run/demo-meridian': patch
---

A narrowed check may name several entity types, and the schema says which

Three timeline operations took `entityType: z.string()` and narrowed to whatever the caller
named, while `{ key, entity, idFrom }` holds one fixed type. #889 declared `entity: 'workorder'`
on two of them — accurate to the app, narrower than the operation — and filed #890 asking whether
the answer was a new `entityFrom` field or simply a bounded input.

**It is both, and the reason is a caller the issue did not know about.** Every call site in the
app, the routes and the portal beats passes one constant, so the cheap answer looked complete:
pin `z.literal('workorder')` and the declaration becomes exact. It isn't complete — Callout's
§12 and Handlebar's counter-signature beat read a **protocol's** spine rows through the same
operation. Two admissible types, then, not one, and the literal turned both scenarios red on
first run, which is how the second type was found at all.

- `entityFrom: 'entityType'` names the input field carrying the type, beside `idFrom` naming the
  one carrying the id. It is an alternative to `entity`, not an addition — one type or a field
  that names several.
- **The admissible types are not listed in the declaration.** They are read off that field's own
  schema (`z.enum(['workorder', 'protocol'])`), so the set exists once. #890's own worry about
  `entityFrom` was that the kit would need a caller-written list, and a list a caller writes goes
  stale; reading the schema is what avoids it.
- An open `z.string()` behind `entityFrom` is reported **uncovered with a reason**, never guessed
  at. `protocol/list-for-entity` is that shape and stays as it is — an engine cannot know its
  callers' nouns, which is the separate half of #890 (see the follow-up issue).

**What the kit does with it.** An `entityFrom` operation is driven **once per admissible type**,
so Callout's timeline now runs its pair over a work order *and* over a protocol — 2 new generated
tests per vertical, all passing, so the handlers were honouring both all along. The kit also reads
a single-valued literal off the schema rather than being handed it: the three fixtures each
restated their constant in `inputs`, a second copy that could disagree with the declaration, and
Handlebar's was quietly deciding that only repairs got tested.

Meridian's `hr/timeline` is the one-type case and keeps `entity: 'employee'`, with
`z.literal('employee')` where the open string was.

**Surface note, stated because it is a narrowing:** the three timelines now refuse an entity type
they used to accept and answer with a validation error rather than a permission denial. No caller
in the repo passes anything else, and the portal is unaffected — a portal customer reads her
order's timeline as `entityType: 'workorder'` and her grant on the CUSTOMER reaches it through the
parent walk (`workorder → facility → customer`), which is what makes the portal work. Meridian's
`openapi.json` records the narrowing as `"const": "employee"`.
