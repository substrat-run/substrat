---
status: historical
layer: plan
description: What an external adopter can generate from Substrat's model packages, and what it still cannot. Re-derived 2026-09-09.
---

# Adopting the model packages — a dated reading

Status: **historical** — a dated reading, taken from `main` on **2026-09-09**. It exists so
the answer is not reconstructed from a conversation each time (#743). It is not maintained:
the packages move, and a reading that claims to stay true is worse than one that says when
it was taken. Re-derive it rather than edit it.

It supersedes the reading in #743, which was taken against `contracts` 0.72.0 /
`model-emit` 0.2.0 and named three blockers that have all since closed.

The reading is written against a specific shape of adopter — the one behind the field report
in [#695](https://github.com/substrat-run/substrat/issues/695), **the SDL adopter**: a whole
vertical modelled as SDL and re-emitted, 55 tables, 159 operations, 164 routes, 73 permission
keys, arriving with an app already mid-life rather than a greenfield one. Their evidence
shaped most of the model phase ([`../rfc/model-phase-plan.md`](../rfc/model-phase-plan.md)
§10.2), and an app that size is where the layer's refusals actually bite, so it is the
useful case to answer.

## 1. What is available now

Versions and licences are the ones the packages carry on the day above.

| package | version | what an adopter gets | licence |
|---|---|---|---|
| `@substrat-run/contracts` | 0.105.0 | `defineEntities`, `defineOperations`, `defineLifecycles`, `manifestEntities`, `manifestOperations`, `defineEngineRoutes`, `apiCatalogFrom`, `emitModel`, `emitLifecycles`, `EntityRow`, `OperationImpl` | Apache-2.0 |
| `@substrat-run/model-emit` | 0.8.22 | `emitTables`, `columnsOf`, `journalColumns`, `journalUniques`, `journalPrimaryKeys`, `planMigration`, `parseJournal`, `readSchema`, `renderClient`, `emitXState` | Apache-2.0 |
| `@substrat-run/vertical-host` | 0.105.0 | `mountOperations` — the declared operation set, served | **AGPL-3.0-only** |
| `@substrat-run/kernel` | 0.105.0 | the runtime the emitted parts run on; `ctx.grant` / `ctx.revoke` | **AGPL-3.0-only** |

Three things on that list did not exist at the 0.72.0 reading, and each answers an ask the
field report made directly:

- **`OperationImpl<Ops, Ctx>`** is the `satisfies Impl` seam it asked for, taken as designed:
  the handler map a declared operation set requires, so the compiler names a drifting method
  instead of a runtime 404 doing it later.
- **`defineLifecycles` / `emitLifecycles`** are the lifecycle tier its `@retired` /
  `@renamedFrom` vocabulary argued for — declarations whose job is to be deleted after use.
- **`renderClient`** emits the browser client from the same model, which is the piece its
  differential harness had no counterpart for.

### The licence seam, stated plainly

**The modelling half is Apache-2.0; the runtime half is not.** `contracts` and `model-emit`
carry Apache-2.0, so an adopter can generate tables, a journal, a manifest, a route table,
an OpenAPI catalogue and a typed client with no copyleft obligation at all — the emitted
output is theirs, and `model-emit`'s only dependency is `contracts`.

The moment the emitted parts are *mounted* — `mountOperations`, or anything reaching
`ctx.grant` — the code is running against AGPL-3.0-only packages, and a commercial licence
is the other door. That seam is deliberate and it is where it is on purpose: measuring
whether two descriptions of an app agree costs nothing, and running the app is the product.
See [`../architecture/marketplace-publish.md`](../architecture/marketplace-publish.md) for
how that plays out on the hosted path.

## 2. The cheapest first move is parity, not generation

Point `emitTables` at the adopter's entities and diff against their journal. One test file,
no runtime, no AGPL, and it tells them exactly where their two descriptions of the app
already disagree. That is how 54 of 55 tables were measured in #695, and it is what six
demos and six of the seven engines run today — `demos/callout` and `demos/handlebar` as
`test/emit-parity.test.ts`, `demos/{manyfold,meridian,rally,shop}` and
`engines/{absence,booking,invites,invoicing,protocol,workorder}` as `test/entities.test.ts`.
(`engines/metering` is the one without it.)

The parity run is also where the emitter's own strictness shows up as a finding rather than
a surprise: it emits `id TEXT PRIMARY KEY NOT NULL`, and a hand-written SQLite schema that
omits `NOT NULL` accepts a NULL primary key. Latent rather than live where ids come from
`ulid()`, and exactly the class of thing this layer is meant to buy.

**Then `planMigration` against the real journal.** It answers one of three ways — up to
date, append exactly one entry, or refuse with a named reason — and all three are useful.
The refusals are the interesting ones, and §3 is what they say.

**The full loop is proven, in two verticals.** `demos/todo/tools/emit-migrations.mts` and
`demos/ticket0/tools/emit-migrations.mts` derive `journal.json` and
`src/migrations.generated.ts` from the model, with nobody writing a version number. That is
the pattern to copy. It is worth knowing that the scaffold `npm create substrat` hands out
does *not* yet do this: it declares its model in `src/entities.ts` + `src/operations.ts`
(#983) but still ships a hand-written `src/migrations.ts`.

## 3. What still cannot be generated

**All three blockers named in the 0.72.0 reading are closed.** A full run is no longer
gated on us:

- [#734](https://github.com/substrat-run/substrat/issues/734) **`renamedFrom`** — shipped.
  It landed as `renamedFrom?: Readonly<Record<string, string>>` on the entity — a
  `{ currentName: previousName }` record, not the `[{ to, from }]` list the RFC sketched.
  `to` must name a real current field, so half of the field report's check 5 is now a
  compile error.
- [#735](https://github.com/substrat-run/substrat/issues/735) **composite keys** — shipped.
  A composite `key` emits a table-level `PRIMARY KEY (a, b)` in declaration order, not one
  UNIQUE per field.
- [#738](https://github.com/substrat-run/substrat/issues/738) **engines declaring their
  operation surface** — shipped. All seven engines export a declared operation set, so a
  composing vertical's route binding is a name and a path rather than a restatement of the
  engine's input. For Callout that was 17 of 27 rows.

What remains is not a roadmap item. It is the set of things the layer **refuses to guess**,
and each refusal names its reason:

1. **`planMigration` refuses anything that rewrites history or loses data.** A dropped table
   or column, a moved or added primary key, a `UNIQUE` constraint added to an existing table,
   and a `NOT NULL` column with no default added to a table that may already hold rows. Every
   one of those is a real decision — expand/contract, a rebuild, a backfill — and it goes to a
   hand-written migration under the migration checkpoint. On a 55-table app mid-life, expect
   to meet several of these on the first run.

   **One thing on that list is not there, and it matters more than the ones that are: a
   retyped column is neither planned nor refused — it is invisible.** The planner diffs
   column *names* (`journalColumns` against `columnsOf`), and an existing name is skipped
   before anything looks at its type, so changing a field's type in the model produces
   `up-to-date` while the live table keeps the old column. The doc comment on
   `packages/model-emit/src/plan.ts` claims a retype is refused; the code does not do it.
   For an app migrating 55 tables that is the one silent failure mode in the loop, so widen
   any parity test to compare `ddl`, not just names.
2. **A column that leaves the model still reads as a drop** unless `renamedFrom` says
   otherwise. #734 makes the rename *declarable*; it does not make it derivable. The
   declaration has to be there before the diff runs.
3. **A composite-keyed table cannot be pointed at.** #735 emits the composite key; a
   single-column foreign key to one is still refused, because a platform `EntityRef` cannot
   name half a key. An entity that is both composite-keyed and referenced needs a surrogate
   id.
4. **History is not a type.** The other half of check 5 — *"the name exists in the previous
   journal and not in the current schema"* — stays in the emitter, read against
   `journal.json`, for the two reasons `../rfc/model-phase-plan.md` §3.3 gives: the type
   system sees one version of the model, and TypeScript has no negative constraint.
   The validator shrinks; it does not disappear.

## 4. Two things that will break on the first compile

Both are mechanical, and both are about the permission review artifact rather than about
the model:

- **`narrows` requires `checks`.** An operation carries `permission` **or** `narrows` with a
  reason, never both and never neither — and a `narrows` block must list this module's
  permission keys the per-entity walk evaluates. Empty is a legitimate answer; absent is
  not. Without it, a key reached only by a proof walk contributes nothing to the derived
  permission list and vanishes from the one artifact where a widened permission is supposed
  to be impossible to miss. A composed engine's keys are deliberately *not* listed — the
  engine's own manifest declares them.
- **An ungated operation needs `unchecked: true` — inside its `narrows` block.** The
  invariant above does not bend: an operation that checks nothing still carries `narrows`,
  with a `reason`, `checks: []` and this flag. It is a third field on that block, not a third
  alternative to `permission` and `narrows`. The flag is needed because `checks: []` alone
  means two different things — a walk whose only key belongs to a composed engine, versus an
  operation that checks nothing anywhere and says why — and it is opt-in on purpose: an
  operation that forgets it is reported as a proof walk, which is the claim that gets
  scrutinised.

## 5. Where the argument lives

[`../rfc/model-phase-plan.md`](../rfc/model-phase-plan.md) — §3 for why the notation is
typed TypeScript rather than SDL (the unchecked-string cost the field report measured is the
deciding evidence), §5.3 for the derived journal adopted from its design, §10.2 for the full
reading. The umbrella issue is
[#685](https://github.com/substrat-run/substrat/issues/685).

The best idea in that report is still the one to hold this note against:

> The best thing a modelling language can do with a rule is not need to express it.

Every row in §3 is a place the platform has not managed that yet.
