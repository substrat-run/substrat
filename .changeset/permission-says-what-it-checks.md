---
'@substrat-run/contracts': minor
---

A declared `permission` says what it checks against.

A bare key was ambiguous in the direction that fails **open**. These read
identically in the model and behave completely differently:

```ts
'todo/create-list': { permission: 'list:create', … }   // checked at the scope
'todo/rename-list': { permission: 'list:manage', … }   // checked on ONE list
```

Only the handler decided which, via `ctx.check(perm)` versus
`ctx.check(perm, entityRef)`. A reader of the model could not tell, a reviewer of
the permission diff could not tell, and an emitter could not generate the check.
Get the second case wrong and the operation passes for anyone holding the key
anywhere in the scope — in a sharing app, any member editing any record — with
every test still green, because only a seed that grants nothing scope-wide would
have caught it.

An entity-narrowed check now says so, and says what it narrows to:

```ts
permission: { key: 'list:manage', entity: 'list', idFrom: 'listId' }
```

`entity` is checked against the declared entities and composed engines; `idFrom`
against the operation's own input, so the check is derivable. Where the id is not
in the input — an operation taking an item but checking the list it sits on —
`resolved: '<reason>'` records that this is not a node check while admitting the
handler must find the entity itself. The two are mutually exclusive and one is
required, so a check cannot silently say nothing.

Six `@ts-expect-error` controls prove each join bites: a bad `idFrom`, a bad
`entity`, both together, and neither. `permissionsUsedBy` reads the key out of
either form, so the permission review is unchanged.

Existing bare-key declarations keep their meaning — the node — and now mean it
explicitly. `demos/todo` adopts the narrowed form on all nine of its
entity-scoped operations.

Progresses #736.
