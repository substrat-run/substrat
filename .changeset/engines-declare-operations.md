---
'@substrat-run/contracts': minor
'@substrat-run/engine-workorder': minor
'@substrat-run/engine-protocol': minor
---

The workorder engine declares its operation surface, and a route binding becomes
a name and a path.

`defineEngineRoutes` shipped taking the input and output schemas from the
composing vertical, because the engine only expressed them as TypeScript types.
That meant a vertical wrote a local `z.object({ orderId })` standing in for a
shape the engine owns — a description held in agreement by nothing — and the
operation NAME was an unchecked string, since `ModuleRegistration` erases its
operation keys.

The engine now declares all eight operations with `defineOperations`, and
`defineEngineRoutes` is curried against them:

```ts
export const calloutEngineRoutes = defineEngineRoutes(workorderOperations)({
  'workorder/get': { method: 'GET', path: '/workorders/{orderId}' },
});
```

The result MERGES the engine's declaration with the path, so the engine's real
schemas reach the router and the API document rather than a restatement. Callout
loses 40 lines of binding.

`http` is deliberately absent from the engine: it is entity-agnostic and owns no
URL shape — a bike shop calls the same work order a repair. `createWorkOrder`
stays an in-scope function rather than an operation, so a vertical can price,
label and link in one transaction instead of being offered a second way in that
skips all of it.

`timeEntry` and `materialLine` are published as Zod schemas rather than
interfaces, because an operation declaring what it RETURNS needs something to
point at.

**Two type-level checks that were decorative, made real.** The path check read
`PathAgainst<Op, string>`, and `PathParams<string>` is `never`, which vacuously
satisfies any input — it accepted every path. It now infers the literal. The
unknown-operation-name check could not be made to bite at all (the constraint is
self-referential and inference degrades), so it is **not claimed**: it throws
when the module loads, naming what the engine does declare.

**And a cycle the permission checkpoint caught.** With the published schemas in
`index.ts` and `index.ts` re-exporting `operations.ts`, importing the engine ran
`operations.ts` before `workOrder` was initialised. They now live in
`schemas.ts`, which both import — the kind of cycle a warm `dist` hides and a
tool that actually imports the module finds immediately.

`@substrat-run/engine-protocol` publishes its four row shapes as Zod —
`protocolTemplateRow`, `protocolResponseRow`, `protocolSignatureRow`,
`protocolSignatureRequestRow` — each asserted **exact** against the interface the
handler returns, in both directions. A declared return that drifts from what is
actually returned is the defect #695 found eleven times, so the assertion is
mutation-tested: widening either side stops the build.

Protocol does not yet declare its operations. Doing so needs its input schemas
moved to a leaf module first — they sit interleaved with the implementation
across a 2000-line file, and `operations.ts` importing them from `index.ts` while
`index.ts` re-exports `operations.ts` is a runtime cycle. See #738.

Progresses #738; unblocks #739.
