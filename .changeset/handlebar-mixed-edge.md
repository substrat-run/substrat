---
"@substrat-run/contracts": minor
---

The mixed edge gets its checkable half checked, and diagnostics name the entities.

Handlebar's permission walk is `customer → bike → workorder → protocol`, and it
crosses the ownership boundary in the middle: `workorder` is engine-workorder's,
`bike` is the vertical's. `foreignRelations` (added by the first adopter) treated
both sides of every foreign edge as unchecked strings — which threw away a check
we hold, because the parent of that edge IS a declared entity.

Split by which half can be checked:

- `foreignChildOf` — foreign child, **local parent**. `parentType` is strictly a
  declared entity; a typo is a compile error.
- `foreignChildren` — neither side ours. Unchecked, and visible as such.

Both collapse back into `parent` when engines export entity-type constants
(#696 item 3).

**Diagnostics.** Entity-name positions are now written `keyof T & string` inline
rather than through the `EntityName<T>` alias. TypeScript prints an alias
*unresolved* — the error named the alias and inlined the entire entity map,
hundreds of characters before anything useful. Inline, it lists the names:

```
Type '"bkie"' is not assignable to type '"bike" | "customer"'.
```

That is one of the costs recorded against the TypeScript decision on #680, and
this is the cheap half of it fixed.
