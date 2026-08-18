---
'@substrat-run/contracts': minor
'@substrat-run/vertical-host': minor
---

`narrows` names the permission keys its walk checks.

An operation that proves access per entity declared only a `reason`, so a key
reached **solely** by a proof walk contributed nothing to the derived permission
surface — and would have been absent from the review artifact that exists to make
a widened permission impossible to miss.

`narrows` now carries `checks: readonly PermKey[]` alongside `reason`, and
`permissionsUsedBy` gathers those keys as well as the leading `permission` ones.
Empty is a legitimate, explicit answer: Callout's portal walk evaluates only
`workorder:read`, which the workorder engine declares — a vertical restating
another module's permissions is the same two-descriptions defect this prevents.

Also adds `manifestOperations(operations, { permissions })`, the operation-side
counterpart to `manifestEntities`: the manifest's `permissions` list and
`events.emits` are derived from what the operations declare, with descriptions
supplied beside the manifest and checked for exhaustiveness. A key an operation
checks that nobody described is an error rather than an undocumented permission.

**Migrating:** add `checks` to every `narrows` declaration — the vertical's own
keys the walk evaluates, or `[]`.

`@substrat-run/vertical-host` gains `mountOperations(app, operations, resolveStub)`,
which derives the Hono route table from the operations' own `http` declarations —
method, path, and which input fields the path carries are already declared and
compile-checked, so writing them again by hand is a second description that
drifts. A runtime derivation rather than a generator: the model is TypeScript, so
`operations` is a live object and there is nothing to emit or regenerate.

It found real drift on first contact. Callout declared `callout/price-list` at
`/price-list` while serving — and its web client calling — `/prices`. Three
descriptions, one wrong, and nothing could contradict it until the route table
was derived from the declaration. The declaration is corrected here.

Scope: a vertical's OWN operations. A composed engine's operations carry no
`http`, because the engine does not own a URL shape — the vertical mounts those
itself.
