---
'@substrat-run/demo-todo': minor
---

Todo's browser client is emitted from its model, and a generated file now carries a gate.

`demos/todo/app/src/api.ts` was 91 hand-written lines, and every fact in it already
existed in `spec/model.ts`: the `List`/`Item`/`Share` interfaces are the entities'
`fields`, the paths and methods are the `http` blocks, the request bodies are the `input`
schemas. It was a second description of a declared thing — the defect this repo already
refuses for the route table (`mountOperations`), the OpenAPI document (`lint:api`), the
permission surface (`lint:permissions`) and the migrations.

It drifted the way a second description does. #811 declared `todo/list-items` paged and
#827 added two search reads; the client learned about neither, so the app rendered the
first twenty items of a list as though that were the list, and shipped no search at all.
Nothing was red, and nothing could be — there was no gate over a file a person maintained
by remembering to.

**`tools/client-emit.mts` (`pnpm lint:client`).** A vertical opts in from its
`package.json`, naming its model and where the client lands:

```json
"substrat": {
  "client": {
    "model": "spec/model.ts",
    "entities": "todoEntities",
    "operations": "todoOperations",
    "out": "app/src/api.generated.ts",
    "name": "Todo"
  }
}
```

The output is standalone TypeScript with no imports at all. That is not tidiness: the app
is a separate Vite package that depends on neither `@substrat-run/contracts` nor zod and
must keep depending on neither, and a checked-in artifact that re-exports its meaning from
another package is not reviewable in a diff. Entity interfaces are matched **by identity**
— `output: todoEntities.item.fields` is the same object, so it prints as `Item`, while an
inline shape that happens to match an entity stays inline. A schema the printer cannot
spell is exit 2 naming the operation and the field, never a silent `unknown`: a generated
client that degrades to `any` is worse than the hand-written one it replaced, because the
green light is now mechanical.

The client also owns the paged wire shape once, so no vertical's SPA re-derives it. It
reassembles a `Page` from the entries body plus `Link` / `X-Total-Count` (#829) and
exposes `follow(next)`, which re-bases the link's path onto whatever the client was
configured to talk to — relative for a browser, which keeps a dev-proxied request
same-origin, absolute for a harness that has no page. `ListView` now walks it, and renders
the `N of TOTAL` count that `paged: { total: true }` had been paying a second query for
with nothing on screen to show it.

What stays hand-written is only what the model does not declare: which principal a request
is made as, and the error envelope the vertical picked in its own `app.onError`. That file
is 33 lines.

**A generated file carries three marks, or it is not generated** (CLAUDE.md): the
`.generated.ts` suffix, a header naming the producer and the source, and a `--check`
re-emit in CI. Only the third enforces anything — "do not edit" is a request.

`src/migrations.ts` becomes `src/migrations.generated.ts`, and the rename was the smaller
half. `emit:migrations --check` only ever asked whether the *journal* was behind the model;
it never asked whether the module still matched the journal, and it re-rendered the module
**only on the run that appended an entry**. A hand-edit to shipped SQL therefore passed
every check in the repo. It now re-renders every run and diffs, which is what the "do not
edit" comment had been doing on its own since the file was written.

New CI steps: `pnpm lint:client --check` and `pnpm lint:migrations --check`.

One exception is stated rather than hidden: a file generated from a *remote* source cannot
be re-emitted hermetically in CI, so `apps/builder/src/rate-card.generated.ts` (models.dev)
and `packages/psl/src/data.ts` (the public suffix list) carry the suffix and header plus a
`GENERATED_AT` stamp instead of a gate. An in-repo source with no gate is a defect, not a
style.
