---
'@substrat-run/contract-tests': minor
---

A conformance kit that catches a node check where an entity check was declared.

An operation declaring `permission: { key, entity, idFrom }` beside a handler
calling `ctx.check(perm)` typechecks perfectly and fails open — everyone holding
the key anywhere in the scope passes, which in a sharing app is every member
against every record. `entityCheckConformanceSuite` generates the behavioural
pair that separates the two, per operation, read off the declaration:

```ts
entityCheckConformanceSuite('todo', todoOperations, makeFixture, {
  inputs: { 'todo/rename-list': { name: 'renamed' } },
  uncovered: { 'todo/set-item-done': "declares 'resolved' — the id is not in the input" },
});
```

Grant on entity A and invoke against A: a correct check allows, a node check
denies, because a narrowed grant does not widen. Grant on A and invoke against B:
a correct check denies. The second is the breach direction; the first is the one
that catches the node check, and it fails as a *baffling denial* rather than as a
breach — the direction nobody files a security bug about. Case 2 deliberately
does not catch the node check, and the suite says so rather than implying
coverage it does not have.

Operations the kit cannot generate — a `resolved` check, or one whose required
input nobody supplied — are reported as uncovered and asserted against a list the
caller writes down, so losing coverage turns CI red and appears in the diff.
`planEntityCheckCoverage` is exported for anyone who wants the partition without
the suite.

`alsoGrant` records the permissions an operation needs beyond the one it
declares, with a required reason. The first vertical it ran against produced one:
a handler that delegates a permission via `ctx.grant` must itself hold the
permission it delegates, so the declared key is the gate it opens with rather
than the whole authority it exercises.

Closes #747.
