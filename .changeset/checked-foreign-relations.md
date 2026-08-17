---
"@substrat-run/contracts": minor
"@substrat-run/engine-protocol": minor
"@substrat-run/engine-workorder": minor
---

**BREAKING:** `foreignChildOf` / `foreignChildren` collapse into `relations`, with both sides checked.

Those two existed for one reason: a relation edge naming an engine's entity could
not be checked, so the pair at least made *which half* was unchecked visible. Now
that engines export their registries, both halves are checkable and the split has
nothing left to say.

```ts
...manifestEntities(handlebarEntities, {
  engines: [protocolEntities, workorderEntities],
  relations: [
    { entityType: 'workorder', parentType: 'bike' },
    { entityType: 'protocol', parentType: 'workorder' },
  ],
})
```

A typo in either position, in either an engine's name or the vertical's, is now a
compile error that lists the composed set:

```
Type '"protocl"' is not assignable to type '"bike" | "customer" | "protocol" | "workorder"'.
  Did you mean '"protocol"'?
```

Local-to-local edges stay **derived** from the entities' own `parents` and do not
belong in `relations` — declaring one twice is how two descriptions of a fact come
to disagree.

**Fix:** the engines' entity registries were not exported.

`protocolEntities` / `protocolInstanceRow` (#712) and `workorderEntities` /
`workorderRow` (#713) were declared and used internally to derive each engine's
row type, but never re-exported from the package entry point — so the composing
vertical they exist for could not import them. They are public now, which is what
made this change possible at all.
