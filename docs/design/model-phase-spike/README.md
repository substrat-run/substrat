# model-phase spike

Evidence for [`../model-phase-plan.md`](../model-phase-plan.md) §3: **can a typed TypeScript
model make CRM-EFF's `validate` checks compile errors, instead of a bespoke validator?**

```
pnpm install            # the spike resolves zod from the workspace
npx tsc -p docs/design/model-phase-spike
```

A **clean run means every check bites.** The harness inverts `@ts-expect-error`, so a check
that stops being enforced turns the build red with *"Unused '@ts-expect-error' directive"*.

## Files

| file | what it is |
|---|---|
| `model.ts` | the type machinery — `defineEntities`, `defineEnv`, `defineModel`, `Impl<M>` |
| `engines.ts` | what an engine package would export: event map, predicate configs, entity types, completion groups |
| `example.ts` · `example2.ts` | valid models — must typecheck clean |
| `should-fail*.ts` | **the deliverable.** Every case must be a compile error |

## Why `should-fail*.ts` is the point

Five times while building this, a constraint that looked correct was **silently inert** and the
valid model still compiled clean — an erased supertype, a generic with no inference site,
`Partial<Record<K, unknown>>` as a constraint, a naked `extends never` that distributed, and
once in a control script whose search string matched nothing.

Type-level constraints fail **permissively**. A decorative constraint is indistinguishable from
an enforced one if you only ever compile the happy path. The failure suite is the only evidence
the constraints exist at all — which is why it belongs in CI permanently, not as a one-off.

When changing anything here, verify in **both** directions:

- remove a `@ts-expect-error` → the real error must surface;
- add one on a valid line → it must be reported as unused.

And assert that any scripted edit actually applied. One control silently matched nothing and
reported a pass.

## Scope

Roughly 26 checks enforced. One is documented as permanently out of reach: CRM-EFF's check 5
(`@renamedFrom` must name something in the *previous journal* and not the current schema) needs
history, which the type system cannot see — and its second half is a negative constraint over an
open set, which TypeScript cannot express. See plan §3.3.

Nothing here is proposed as final API. The question is only what the type system can carry, and
at what ergonomic cost.

## Note

`tsconfig.json` maps `zod` to a pinned path under `node_modules/.pnpm`, so the spike typechecks
without being a workspace package. That path contains an exact version and will need updating
when zod moves.
