---
'@substrat-run/model-emit': minor
'@substrat-run/demo-handlebar': minor
'@substrat-run/demo-callout': minor
'@substrat-run/demo-todo': minor
---

A vertical's browser client is emitted from its model, and a generated file carries a gate.

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

## `renderClient` in `@substrat-run/model-emit`, `tools/client-emit.mts` around it

The printer lives in the package because that is already the package's job — build-time
tooling over a Substrat model, where `emitTables` turns entities into DDL. The tool keeps
the sweep and the IO.

The split is what makes it testable, and it needed to be. `--check` re-emits and compares,
so it catches a client that fell BEHIND its model; it cannot catch a printer that has been
confidently mis-spelling `z.array(z.union([...]))` since the day it was written — the
emitted file and the re-emitted file agree perfectly, and both are wrong. 118 tests now
assert exact strings for optionality (`a?: T`, never `a?: T | undefined`), parenthesised
unions inside arrays, brands, pipes, discriminated unions, identity naming, every refusal,
and a rendered client end to end.

## Opting in (`pnpm lint:client`)

A vertical opts in from its `package.json`, naming its model and where the client lands.
The output is **standalone TypeScript with no imports at all**. That is not tidiness: the
app is a separate Vite package that depends on neither `@substrat-run/contracts` nor zod
and must keep depending on neither, and a checked-in artifact that re-exports its meaning
from another package is not reviewable in a diff.

Types are matched **by identity** — `output: todoEntities.item.fields` is the same object,
so it prints as `Item`, while an inline shape that happens to match an entity stays inline.
A schema the printer cannot spell is exit 2 naming the operation and the field, never a
silent `unknown`: a generated client that degrades to `any` is worse than the hand-written
one it replaced, because the green light is now mechanical.

It owns the paged wire shape once, so no SPA re-derives it — a `Page` reassembled from the
entries body plus `Link` / `X-Total-Count` (#829), and `follow(next)` which re-bases the
link's path onto whatever the client was configured to talk to.

**The source may be a `defineOperations` bag or an `ApiCatalog`.** They carry the same five
fields the emitter reads (`summary`, `input`, `output`, `http`, `paged`), so a vertical that
documents its API already has most of what this needs; what it lacks is `output` and `http`
per operation, not a migration.

## Three verticals

| | hand-maintained | now | removed |
|---|---|---|---|
| todo | 91 | 33 | −58 |
| callout | 305 | 203 | −102 |
| handlebar | 234 | 131 | −103 |

What survives is only what no model declares: which principal a request carries, the error
envelope each vertical picked in its own `app.onError`, the dev harness's `/cast`, and the
handful of operations left deliberately unbound because they take an entity-agnostic
`entityType` — binding `callout/timeline` or `protocol/list-for-entity` to a URL would let
a caller name any entity at all.

Callout and Handlebar compose three engines each, which the emitter reads as further
operation bags (`defineEngineRoutes` returns the same objects with `http` attached). A
composed engine keeps its prefix — `workorderGet` / `protocolGet` / `invoicingGet`, because
three engines each declare `get` and renaming an engine's operation to suit a vertical's
client is not a thing a vertical may do.

## What generating them found

- **A live drift.** `bike-shop/price-list` declared `GET /price-list`; the server has always
  served `/prices`. Handlebar mounts by hand, so nothing checked, and the declaration was
  decorative. A client generated from it would have 404'd on its first request.
- **Two latent runtime bugs**, both caught by the compiler because the generated type is the
  engine's real one. `ProtocolDetail.content` is a union — checklist **or** document — and
  both apps' hand-written interfaces declared only the checklist arm, so a document protocol
  would have thrown on `.sections` of undefined. `underlagLine.source_id` is nullable, and
  Handlebar's invoicing view linked through it unconditionally.
- **Ten operations declared without an `http` block** (four in Callout, six in Handlebar),
  so each SPA hand-wrote calls to routes the vertical already served. Binding them is also
  what let both route tables become derived below; each new path was verified against the
  one the hand-written table served before it was replaced.
- **A name shadow.** Callout and `engine-protocol` both export `instantiateProtocolInput`
  with different shapes. Harmless, but it is why the emitter resolves each configured export
  individually and refuses only a name it was actually asked for.

## Generated files carry three marks, or they are not generated

CLAUDE.md now states it: the `.generated.ts` suffix, a header naming the producer and the
source, and a `--check` re-emit in CI. Only the third enforces anything — "do not edit" is a
request.

`demos/todo/src/migrations.ts` becomes `src/migrations.generated.ts`, and the rename was the
smaller half. `emit:migrations --check` only ever asked whether the JOURNAL was behind the
model; it never asked whether the module still matched the journal, and it re-rendered the
module only on the run that appended an entry. A hand-edit to shipped SQL therefore passed
every check in the repo. It now re-renders every run and diffs.

New CI steps: `pnpm lint:client --check` and `pnpm lint:migrations --check`.

One exception is stated rather than hidden: a file generated from a REMOTE source cannot be
re-emitted hermetically, so `rate-card.generated.ts` (models.dev) and `packages/psl/src/data.ts`
(the public suffix list) carry the suffix and header plus a `GENERATED_AT` stamp instead of a
gate. An in-repo source with no gate is a defect, not a style.

## Both hand-written route tables go too

Callout's `src/routes.ts` (180 → 102) and Handlebar's route block in `src/server.ts`
(129 lines → a `mountOperations` call) were the other half of the same duplication: every
line restated a method and a path the operations already declare. The comments they had
accumulated are the argument against them — one explaining that `/customers/search` must be
registered before any `/customers/:id` route or Hono answers it with `id: 'search'`, another
explaining that `limit` arrives as a string and must be coerced because the operation
declares a number. Both are real, and `mountOperations` derives both from the same
declarations (#785). A hand-written table has to remember.

What stays hand-written in each is the two routes that supply a CONSTANT — `timeline` and
`protocol/list-for-entity` both take an entity-agnostic `entityType`, and binding either
would let a caller read the timeline, or the protocols, of anything in the scope.

Callout's route-parity test is rewritten rather than kept. It existed to prove the
derivation matched the hand-written table so the table could be replaced; now that
`routes.ts` IS the derivation, that assertion is one thing equalling itself, and a test that
cannot fail is worse than no test because it still reads like coverage. What replaces it is
the part that was never tautological: the declared surface pinned as an exact list, the two
exceptions still being served, and the static-before-parameter ordering.

**One deliberate behaviour change.** Handlebar's pickup refusal now answers **409**, not
400. The engine declares that error's taxonomy code (#113) and `mountOperations` honours it;
Handlebar's hand-written `onError` could not see the code and flattened everything
unrecognised to 400. Both apps' `onError` now converts the mount's `HTTPException` back into
their own `{ error }` body — Callout's previously returned `err.getResponse()`, whose body is
Hono's, not `{ error }`, which the SPA reads off every failure.

## Verified

Each client was driven against its own running server, not just typechecked: todo walks a
45-item list across three pages with a correct total; Callout runs an order from creation
through protocol sign to invoicing and refuses a portal user's write with a typed 403;
Handlebar's pickup rule holds — `closeRepair` is refused until the customer counter-signs the
tillståndsrapport, and succeeds after. Both were driven again after their route tables became
derived: same lifecycle, same 403/404/400 envelopes, the `z.literal('workorder')` pin still
holding against a caller who sends `entityType: 'customer'`, and `/customers/search` still
reached rather than swallowed by its parameter sibling.
