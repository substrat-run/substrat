---
'@substrat-run/contracts': minor
---

`manifestOperations` gains `checksDeclaredElsewhere` — a vertical can name the engine keys it enforces

A vertical composing an engine is gated by the engine's permission keys as well as its own.
Until now it had no way to say so: every key an operation checked was derived into that
module's own manifest `permissions` list, so declaring `workorder:read` on a vertical
operation meant two modules declaring one key, with two descriptions free to drift apart.

The available alternative was to name a key the operation does not actually check, and
Callout took it — `callout/timeline` declared `customer:manage` at the node while the
handler enforced `workorder:read` on the entity. A `technician` holds `workorder:read` and
not `customer:manage`, so the generated permission snapshot said a technician could not read
a timeline that a technician could read every time.

```ts
manifestOperations(calloutOperations, {
  permissions: { 'customer:manage': '…', 'facility:manage': '…' },
  checksDeclaredElsewhere: { 'workorder:read': '@substrat-run/engine-workorder' },
});
```

Listed, never inferred, and true in both directions: an unlisted key is still an error, an
entry naming a key no operation checks is an error (a stale exemption reads as a dependency
that is still there), and a key both described here and declared elsewhere is an error
(one module owns a key, and its description belongs with it).
