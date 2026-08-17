# The model phase — a plan

Status: draft for review. Written **before** reading `Egeryds/CRM-EFF`, deliberately, so
that it and their implementation are two independent descriptions and every disagreement
between them is a defect in one of the two. **Proposes** changes to #680/#681/#684/#685 — it
decides nothing on its own; the issue-by-issue mapping is §9, and §3's notation
recommendation is open until #680 is called.

Evidence base: #695 (a production vertical modelled as SDL, re-emitted, and diffed against
the hand-written app — 55/55 tables column-exact, 159 operations, 164 routes, 73 permissions
reproduced; 51 defects in the hand-written schema; 5 classes of defect in the running app).

---

## 1. The frame

The model phase is **not a stage that produces a frozen artifact**. It is a loop that owns
one artifact — the declared model — which is:

- the **source of truth** for everything structural,
- **revised only from upstream** (business, requirements), never from what got built,
- **regenerated from freely**, at a cost that falls as close to zero as the data phase allows.

Three of those four words in "frozen fork-point contract" survive. *Frozen* does not, except
in the narrow sense of §5.

## 2. What the model declares — and what it must not

The single most important boundary in this plan. Four tiers:

| tier | contents | who writes it |
|---|---|---|
| **Declared** | entities + fields + types; relations (incl. parent edges); operations (name, input, output, permission, emitted event); permission keys + roles; events (type, `schemaVersion`, payload shape, `piiClass`, subject, entity); schedules | the model phase, human-approved |
| **Prose** | state machines, pricing, denial reasons, seed cast, domain rules | `spec/concept.md`, human-approved |
| **Emitted** | migrations, Zod input schemas, route table, `ModuleManifest`, permission registry, `ApiCatalog` + OpenAPI, operation stubs, event-emit scaffolding, row types, ER diagram, SDL view | **code, not AI** |
| **Authored** | handler bodies, the business logic inside the stubs, seeds, the UI | AI, gated |

The bright line: **the model says what exists and what shape it has; prose says how it
behaves; the AI writes behaviour into emitted stubs.**

**A fifth tier, found by CRM-EFF (§10.2) — lifecycle.** `@retired(because:)` and
`@renamedFrom(name:)` are neither "what exists" nor "how it behaves": they say how the
*current* model relates to the *previous* one, and they exist solely to make a diff
interpretable. The four tiers above had no home for them, which is exactly the failure mode
§10.2 was told to look for. They are declared, human-approved, and **transient** — a
`@renamedFrom` is deleted once the entry performing the rename is released; a `@retired`
tombstone expires two released journal entries after its DROP ships. A tier whose members are
designed to be removed is the tell that it is its own thing.

#680's rule holds unchanged and is the test for boundary slip: *inventing `@transition` means
the boundary slipped.* A state machine in the model is the failure mode to watch for.

**The escape hatch, when a declaration cannot express something.** Wasp's `crud` is the
instructive case (§10.1): the declaration names which operations exist, and where the default
cannot carry the logic — *"CRUD operations don't know that a task should be connected to the
user creating it"* — you supply `overrideFn`, a **pointer to authored code**. The vocabulary
did not grow; a reference out of it did. That is the rule to adopt:

> When the model cannot express something, the answer is a named pointer to authored code —
> never a richer declaration vocabulary.

This is what keeps §2's line from eroding one reasonable-looking directive at a time, and it
is a concrete answer to #680's `@transition` worry rather than only a warning about it.

**Why this split is the one that pays.** #695 is direct evidence that the *Emitted* tier can
be carried by a deterministic emitter: 55/55 tables, 159 operations, 164 routes, 73 permission
keys, 10 roles, events and schedules all exact against a production app, with 31/31 + 42/42
differential probes byte-identical. That is a large fraction of a build's output tokens moved
from a language model to a program that is fast, free, and consistent across runs.

## 3. Notation — the open fork, and my recommendation

#680 specifies GraphQL SDL. I land somewhere else, and this is the highest-value
disagreement to test against CRM-EFF (§10.2).

**The case for SDL (#680's):** LLM-fluent, human-skimmable, parseable without executing it
(`graphql-js buildSchema`), directives are a natural extension point, and mature schema-diff
tooling exists — which §5's never-frozen requirement genuinely needs.

**The case against:** it is a query language's type system pressed into service as a data
modelling language. Concretely, from #695: nullability semantics do not match the platform's
(`z.string().nullable()` is *required*, with `null` as the meaningful clearing value; SDL
cannot distinguish that from optional, and an optional argument transcribes to `.optional()`,
which refuses exactly that `null`). No native Money/Decimal. Input/output type duplication.
No way to express an index. And it introduces a **transcription step** — SDL → Zod — which is
precisely the step that produced 40 wrong argument names in their hand-written schema.

**The in-house precedent points the other way.** Two of the platform's own artifacts already
solve this problem, both by refusing a second language:

- `definePermissions({ modules, roles, entityGrants })` ([deploy.ts:392](../../packages/contracts/src/deploy.ts#L392)) —
  a typed TS object that *is* the source, adopted after `permissions.json` proved a checked-in
  artifact drifts.
- `ApiCatalog` ([openapi.ts:22-38](../../packages/contracts/src/openapi.ts#L22-L38)) — holds real
  `z.ZodType` objects, "the SAME object the handler parses", so *"the document cannot drift
  from the enforcement (decision 22 cashed in)"*.

**Recommendation: the authored model is a TS module exporting `defineModel(...)`**, one layer
up from `definePermissions`, with the Zod schemas as the field/input types. Then:

- **no transcription for inputs** — the model's Zod objects *are* the validators the handlers
  parse; the class of defect that hit them 40 times cannot occur;
- **the model typechecks itself** — the model phase gets a gate for free, where SDL needs a
  bespoke validator;
- **`piiClass`, `Money`, branded ids, nullable-vs-optional** are expressible because they are
  the platform's own vocabulary, not approximations of it.

**The decisive argument came from the SDL implementation itself (§10.2), against its own
choice.** Because GraphQL directives cannot take type references, *every* cross-reference in
their language is an unchecked string — `@relation(parent:)`, `@projected(by:)`,
`@emits(payload:)`, `@guard(config:)`, `@renamedFrom(name:)`, `@http(path:)`. Their own words:

> The parser catches not one typo in any of them. […] this is the largest tool in the
> toolchain, larger than the emitter.

and in `future.md`, listed under *unsolved*: *"it is the most important tool in the toolchain
and it is larger than the generator."*

Their `validate` enumerates 22 checks. Roughly the reference-integrity half — parent refs
resolving, `@entity(key:)` naming real fields, `entityIdFrom` naming a real input field,
`@effect(enabledBy:)` naming a declared env key, `{var}` in a path naming an argument — is
**free in a typed TS model**: `keyof`, typed ref constants, template-literal types. The
compiler does it, and there is no tool to build or keep correct. The cross-module checks
(9–12, which need the composed engines' manifests) and the semantic rules (13–17: every
mutation emits, no query emits, no `@emits` payload names an `@erasable` field) stay real work
in either notation.

So the recommendation below is not only in-house precedent — **it deletes roughly half of the
largest tool in their toolchain.** That is their measurement, arrived at independently, and it
is worth more than my argument from `definePermissions`.

### 3.1 Spiked, and the claim held — `docs/design/model-phase-spike/`

435 lines, ~1 hour, `tsc --strict`. **Nine of the 22 checks are compile errors in a typed TS
model, plus CRM-EFF's `satisfies Impl` seam.** Run it with
`npx tsc -p docs/design/model-phase-spike`.

| check | what it catches | bites |
|---|---|---|
| 1 | `parent` names a declared entity | ✅ |
| 2 | `key` names fields that exist on *that* entity | ✅ |
| 3 | `emits.entity` names a declared entity | ✅ |
| 4 | `projections.by` resolves to a declared operation | ✅ |
| **6** | **`entityIdFrom` names a field of the OUTPUT** | ✅ |
| 7 | `schedules.operation` names a declared operation | ✅ |
| 8 | `effect.enabledBy` names a declared env key | ✅ |
| 18 | every `{var}` in an HTTP path names an input field | ✅ |
| 21 | `effect.host` ∈ `outbound` | ✅ |
| — | impl drifted from its declared return (`Impl<typeof model>`) | ✅ |

Check 6 is **the #695 case** — 18 operations emitting `entityId: String(result.id)` on outputs
that answer with `contractId`/`runId`/`instanceId`. The error names the valid options:

```
error TS2322: Type '"id"' is not assignable to type '"contractId" | "status"'.
```

### 3.2 Round 2 — the cross-module checks, and a correction

Round 1 concluded that CRM-EFF's checks 9–12 "need the composed engines' manifests and stay
real work in any notation". **That was wrong, and it was wrong because it inherited the SDL
framing.** An SDL file cannot import anything, so cross-module reference integrity is
necessarily manual. An engine is an npm package: in TypeScript it *exports its contract* and
the vertical's model *imports it*, and the cross-module checks become ordinary type checking.

Six more checks, all biting (`engines.ts`, `example2.ts`, `should-fail2.ts`):

| check | what it catches |
|---|---|
| 9 | a consumed event type no composed engine emits |
| 9 | an event emitted by an engine that is **not** in `engines` |
| 10 | a guard predicate no composed engine contributes |
| 10 | a guard config that does not match the engine's declared shape |
| — | a guard bound to an operation that does not exist |
| **#696** | **a consumer payload field that is not on the engine's payload** |
| **#696** | **a half-handled completion group** |

The last is the Egeryds production defect — consuming `protocol.signed` and not
`protocol.countersigned`, so every multi-party contract stayed `pending` for ever. As a type:

```
Property '"protocol.countersigned"' is missing … but required in type
  { readonly "protocol.countersigned": (payload: never) => Promise<void> }
```

This works by having the engine declare `completionGroups: { signature: ['protocol.signed',
'protocol.countersigned'] }` — events that report the same fact by different routes. Handle one,
and the type demands the rest. That is #696's item 2 with an exhaustiveness rule on top, and it
is worth adding to that issue's proposal.

**Revised remainder.** Not thirteen — closer to eight, and some of those are probably typeable
too (11 and 12 look like the same pattern as 9 and 10). What genuinely cannot be a type:
check 5, which asks whether `@renamedFrom` names something in the *previous journal* — history
is not in the type system. And check 22, which is about what generated code reads, so it is a
lint on the emitted tier rather than on the model.

### 3.3 Round 3 — the adversarial directives, and the first genuine limit

The ones I predicted would push back: `@gate`, `@narrows`, and the migration lifecycle.
Seven more checks bite (`should-fail3.ts`), and one does not.

| check | what it catches | bites |
|---|---|---|
| `@gate` | a gated field that is not on the OUTPUT | ✅ |
| `@gate` | a gating permission that is not declared | ✅ |
| — | a leading `permission` that is not declared | ✅ |
| **14** | an operation carrying **both** `permission` and `narrows` | ✅ |
| **14** | an operation carrying **neither** | ✅ |
| — | `narrows` without a reason | ✅ |
| 5 (partial) | a rename whose target is not a real current field | ✅ |
| **5** | **`@renamedFrom` naming something valid** | ❌ |

**A second correction.** Check 14 — *"every Mutation has `@op(permission:)`, or `@narrows` with
a reason"* — is one of the semantic rules 13–17 that §3 called "real work in either notation".
It is a discriminated union, and it is free:

```
Property 'permission' is missing … but required in type
  { readonly permission: "contract:amounts" | "contract:read"; readonly narrows?: undefined }
```

Declared permissions also make typos a *suggestion*, not just an error:
`Type '"contract:amount"' is not assignable … Did you mean '"contract:amounts"'?`

**The genuine limit, and it is worth stating precisely.** CRM-EFF's check 5 is
*"`@renamedFrom(name:)` exists in the previous journal **and not** in the current schema."*
Neither half is a type, for two different reasons:

1. **History is invisible.** The type system knows one version of the model. Whether a name
   existed in the previous journal entry is a fact about `journal.json`.
2. **Negative constraints do not exist.** TypeScript cannot say *"any string except these"* —
   `Exclude<string, 'a'>` is still `string`. Positive membership (`key` must name a real field)
   is free; non-membership is not.

So the shape was chosen to make the checkable neighbour checkable — `renamedFrom: [{ to, from }]`
where `to` must name a real current field — and **both halves of check 5 stay in the emitter**,
read against `journal.json`. This is the clearest evidence that the validator shrinks rather
than disappears, and it lands exactly where §5.3 predicted: the lifecycle tier is about history,
and history is not a type.

### 3.4 Round 4 — `@erasable`, and one place the types beat the SDL implementation

CRM-EFF calls check 15 *"the check the whole PII posture rests on"* — no event payload may
carry a field marked `@erasable`, because immutable events are the one place in a scope an
erasure cannot reach. They also call their own implementation of it crude, and say why: it
matches the field **name** across all entities, so *"a different `email` that is not erasable
would be refused too. Sound in the safe direction, but crude."*

A typed model resolves through `emits.entity` instead, so it refuses the erasable fields of
**the entity the event is actually about** and no others. Four checks bite:

| check | what it catches |
|---|---|
| 15 | an `@erasable` field riding in an event payload |
| — | `piiClass` other than `'none'` with no `subjectId` to key the erasure |
| — | a `subjectId` that is not a real output field |
| — | `@erasable` naming a field the entity does not have |

The payload error is precise about what remains legal:

```
Type '"name"' is not assignable to type '"customerNumber" | "id"'.
```

**The precision is verified, not assumed.** A control marked `email` erasable on a *second*
entity and the same payload, unchanged, flipped from accepted to rejected:
`Type '"email"' is not assignable to type '"id"'`. Same field name, same operation shape,
different entity — so resolution is genuinely entity-scoped rather than name-matching. That is
strictly better than the SDL implementation **by its own stated standard**, and it matters
beyond tidiness: a check that refuses correct code trains people to work around it, which is
how a PII rule stops being obeyed.

**A refinement to §3.3's limit.** Round 3 concluded that negative constraints do not exist in
TypeScript. That is true of `Exclude<string, 'a'>`, where the domain is open. It is **not** true
of `Exclude<'id' | 'name', 'name'>` — over a finite union of literals, exclusion works exactly.
So the real rule is narrower than round 3 stated:

> Negative constraints work over closed sets and fail over open ones.

`renamedFrom.from` fails because any prior name is admissible (open). `payload` succeeds because
a payload field must be one of the output's fields (closed). Worth knowing before designing any
further rule as a prohibition.

**One deliberate strictness.** The `piiClass` union makes classification mandatory — an event
that omits it does not compile. That mirrors `contracts/events.ts`, where `domainEventInput`
requires `piiClass` and a `superRefine` demands `subjectId` whenever it is not `'none'`, with
the message *"crypto-shredding must be able to key the erasure"*. The same invariant, moved
from runtime to compile time. Three existing spike examples had to be updated to satisfy it,
which is the rule doing its job.

### 3.5 The real finding across all four rounds

Three separate times, a constraint that looked correct was **silently inert**, and the valid
model compiled clean every time:

1. Round 1 — operations routed through an erased supertype; every per-operation check dead.
2. Round 2 — `Consumers` had no inference site, so the completeness check saw an empty key set.
3. Round 2 — `Partial<Record<EventKey, unknown>>` as a constraint; an all-optional record is
   structurally satisfied by an object carrying *extra* keys, so unknown event types passed.

A fourth, inside the type machinery itself: a naked `Extract<…> extends never` distributed and
yielded `never` for every group, silently disabling the completion check. `[X] extends [never]`
is the fix.

**And a fifth, in the verification layer, which is the one worth remembering.** A control that
removed a `@ts-expect-error` to prove the underlying check fires **matched nothing** — the
search string had the wrong indentation — and reported a clean pass. A test that silently tests
nothing, while verifying the tests. It was caught only because the result was *contradictory*
(no error surfaced, yet the unmodified suite reported no unused directive either), not because
anything failed. The fix is trivial and should be a rule: **every harness edit asserts that it
applied.**

**Type-level constraints fail permissively, and the happy path cannot distinguish an enforced
constraint from a decorative one.** Every one of these compiled clean and checked nothing. The
consequence for anything that ships:

> The `should-fail` suite is not a test of the model. It is the only evidence that the model's
> constraints exist at all, and it belongs in CI permanently.

The spike's harness inverts `@ts-expect-error`, so a check that stops biting turns the build red
with *"Unused '@ts-expect-error' directive"* — verified in both directions at each round before
trusting a green run.

Honest cost, now larger than round 1 implied: **373 lines of type machinery** (`model.ts` +
`engines.ts`) against 435 lines of model and harness. Parts of it are genuinely arcane —
`UnionToIntersection`, the `[X] extends [never]` bracketing, and self-referential mapped
constraints in three places — and it will need real comments wherever it lands. That is the
trade against a bespoke validator CRM-EFF describes as larger than their emitter.

The fix in every case is a **self-referential mapped constraint** — each member checked against
its own declared shape rather than against an erased supertype:

```ts
const Ops extends { readonly [K in keyof Ops]: OperationShape<Ops[K], …> }
```

It appears three times (operations, consumers, guards) and is genuinely non-obvious; it will
need a real comment wherever it lands. `const` type parameters are also required throughout,
for literal inference.

Honest counterweight: they made SDL work at full scale — 25 directives, a derived migration
journal, a production app reproduced exactly. The fork is not forced, and the cost of SDL is
now *measured* rather than speculative. One related hole they found that neither notation
closes: a changed **return** shape breaks the impl at the exact method, but an added required
**input** does not, because TypeScript legally lets a function ignore an argument — input
drift surfaces at the Zod layer as a silently dropped field. Zod-as-model removes the
model→validator transcription; the validator→impl hop keeps the hole either way.

**External confirmation, and it is strong.** Wasp ran this exact experiment and landed the
same way — a custom DSL (`main.wasp`), a TS config preview at 0.15, the DSL retired outright
in June 2026. Their stated reasons: the DSL was *"more trouble than it was worth"* and
*"started blocking us in further growing Wasp"*; it needed its own IDE extension, where TS
gives type checking, autocompletion and go-to-definition for free; and a TS spec can use
third-party libraries, split across files, define helpers, loop, and read env vars. Admitted
cost: slightly more verbose. Note also that they iterated *within* TS (class-based
`new App(...)` → function-based `app({ spec: [...] })` at 0.24) — picking TS does not end the
notation question, it just moves it somewhere cheap to revise.

**The one thing they have not solved is the one that decides this for us.** A Turing-complete
spec must be *executed* to know what it says; nothing in their announcement addresses static
analysis, and their only related mechanism is bundler magic turning `with { type: "ref" }`
imports into reference objects without evaluating the target. For Wasp that is fine — the
spec is trusted developer code on a developer's machine. **For a hosted multi-tenant platform
it is not**: a console rendering a tenant's model must never execute tenant code, and a
Turing-complete model is not diffable at the source level.

So the emit is not a convenience — it is what makes the TS choice viable in a context Wasp
never had to face:

**The model emits a checked-in `model.json`** (the `openapi.json` pattern), with the SDL view
and ER diagram derived from *that*, never from the TS source. It is the same shape as
`lint:permissions`: `MODULES` + `ROLES` are TypeScript, `PERMISSIONS.md` is the diffable
artifact.

### CORRECTION — `model.json` is not for every consumer

An earlier version of this section said *"everything downstream reads `model.json`, never
the TypeScript."* That is **too broad**, and it conflates renderers with generators.

`emitModel` goes through `z.toJSONSchema`, which keeps the DECLARATIVE constraints and
silently drops the PROGRAMMATIC ones. Measured:

| declared | in `model.json` |
|---|---|
| `.min(1)`, `.regex(…)`, `.enum([…])` | preserved |
| `.nullable()`, `.optional()`, `.default(…)` | preserved |
| `.brand<'ThingId'>()` | **gone** — plain `{"type":"string"}` |
| `.refine(v => …)` | **gone** — plain `{"type":"string"}` |

A generator emitting Zod validators from the JSON would therefore produce validators
**weaker than the model declares**, accepting input the model rejects, with no trace of the
loss. That is exactly the defect class this whole effort removes — a second description
that disagrees with the first and nothing holding them together.

So the split is by consumer, not blanket:

| consumer | reads | why |
|---|---|---|
| a code generator | **the TS module** | needs the live Zod objects; the JSON round-trip loses refinements and brands |
| a hosted console, an ER diagram | `model.json` | must never execute a tenant's code |
| the diff classifier, the review checkpoint | `model.json` | wants stability and diffability, not validators |

This also refines the swappability argument. `model.json` keeps the notation swappable for
the renderers; a generator's stable interface is the **exported object** — what
`defineEntities` / `defineOperations` return — not the file's syntax. A different authoring
layer producing the same object shape still works, and `model.json` is a lossy *projection*
of that object for consumers who cannot run it.

Honest cost: a TS object literal is less skimmable than SDL for a non-technical approver. I
think that argument is void, because the approver reads **the diagram** (#684), not either
text.

## 4. The direction rule

> The entity model changes for one reason: the business changed, or the business was
> misunderstood. It never changes to accommodate what was built.
>
> **May author a change:** a requirement, a new feature, a corrected understanding of the domain.
> **May not author a change:** generated code, handlers, the UI, a build that will not go green.

**Downstream may falsify the model; it may never author it.** #695 found 11 fictional return
types *by building* — the compiler proved the model described something that cannot exist.
That is information, and information flows any direction. What may not flow upstream is
*authority*: a contradiction is a **ticket back to the model phase**, resolved against the
business, and the resolution may differ from what the code wanted. (`customer/get` returning
the customer plus its children is the case in point: the code was right that the model was
wrong, and still should not have decided what replaced it.)

**Mechanically enforced, not merely stated.** #680 already builds half of it — a spec-only
write guard, the `interviewWriteGuard` mechanism ([phase.ts:42](../../apps/builder/src/phase.ts#L42),
wired at [agent.ts:347](../../apps/builder/src/agent.ts#L347)). The rule is its mirror:

- **model turns** write `spec/**` only (as interview turns do today);
- **build turns may not write `spec/model.*` at all.**

A model change then cannot happen inside a failing-build repair loop; it requires re-entering
the model phase, which is a visible transition with an approval attached rather than a silent
edit in continuation 14 of a gate-repair spiral.

Two consequences, both accepted deliberately: the model phase is **re-entered often** (it is a
loop, not a stage), and a build genuinely blocked on a modelling error must **stop** rather
than work around it. A build working around a wrong model is how 159 operations come to agree
with a schema that is wrong 51 times.

## 5. Lifecycle — never frozen, but classified

"Frozen" in #681/#685 means *frozen within a build run* — the generator transcribes and never
re-derives, so lanes cannot drift mid-build. It has never meant frozen forever, and the
wording should be fixed in both issues before it hardens into a design constraint nobody chose.

The real axis is two questions, not one:

| | **additive diff** | **breaking diff** |
|---|---|---|
| **pre-data** | regenerate silently | regenerate silently — #115: drop, recreate, re-seed |
| **post-data** | regenerate + append a migration | gate: expand/contract, `schemaVersion` bump, dual-emit window (#128) |

Three cells already have doctrine. **#115 owns the entire left column** and the phase flip,
and it was filed a month before #680 presupposing exactly this artifact: *"Pre-data: entity
definitions are source of truth; drop-and-recreate schema + re-seed on every change; no
versioning at all."*

What is missing is **the classifier** — is this diff additive or breaking? That is #685's
parked schema-diff tooling, and it is D-22's breaking-change lint pointed at the model.

Where "low cost" stops holding: regenerating *code* is cheap in every cell. Regenerating the
*migration journal* is cheap only pre-data — after that, append-only means the emitter must
turn a model diff into a **migration delta**, never a fresh schema. That is the bottom-right
cell and the real engineering behind "change and regenerate".

### 5.3 The journal is derived — adopt CRM-EFF's design wholesale

This plan left the migration delta as named work. They designed it, and the design answers a
question I had not thought to ask: **who writes the version number?** Nobody.

The model states the current shape. `journal.json` is a generated, committed artefact holding
the ordered migrations and the DDL each applied. Generation: reconstruct the model as of the
last journal entry *from the journal itself*, diff against the current model, and if the diff
is non-empty append **one** entry — a monotonic derived counter plus a slug
(`0027-route-end-office`).

- **Unreleased entries are free.** Renumber, merge with a sibling, rewrite.
- **Released entries are frozen.** The generator refuses to touch one; a diff that would
  require it is a hard error, not a warning. *"Released" is read from the changeset that
  shipped it* — an existing fact, not an invented one.
- **Branches collide correctly.** Two branches both generate `0027` → a merge conflict in
  `journal.json`, which is the right signal on an append-only ordered list. Resolution is
  mechanical: merge the model, re-run, it renumbers.

The evidence that hand-numbering fails is in their repo already: it ships **two migrations
numbered 0010** (`0010-lead-edit` and `0010-rutt`), working only because `module.ts`
concatenates the arrays in a fixed order. Two people numbering by hand in two branches
produced it once already.

**The principle behind it, which generalises past migrations:**

> **Never declare what a diff can derive.**

They record `@since(version:)` as their design mistake and say why: *"If the diff already knows
the field is new, the version is derived — and declaring a derived fact is the thing this whole
layer exists to stop."* The practical damage was exactly the collision above.

**The one irreducible declaration** is `@renamedFrom(name:)`: a diff sees a field gone and a
field arrived and cannot know they are the same field; without the declaration the generator
emits drop-plus-add and the data is gone. That is the only genuine ambiguity in the whole
journal — a clean instance of §8 rule 1 (absent must be an error, never a guess, on anything
load-bearing).

**Expand/contract becomes impossible to skip rather than merely mandatory.** The generator
refuses a field that goes from present to absent in one commit without passing through
`@retired`; and the tombstone expires — a `@retired` declaration becomes removable two released
entries after its DROP shipped, with the generator reporting which are eligible, so the model
does not accumulate gravestones. They also deliberately refused to reuse GraphQL's
`@deprecated` for the contract phase: it has a spec-defined meaning about *clients*, and fusing
an API signal with a storage phase makes two independent facts inexpressible separately.

**Honest status, from their own gap list:** expand/contract is *designed and unexercised* —
their emitter implements six directives and `@retired` is not among them, the app has never
removed a column, and SQLite's narrow `DROP COLUMN` support may force a logical drop recorded
against a column left in place. The diff classifier is likewise *"derived from what a diff can
see, not from a history of real breakages. It will be wrong somewhere. It is written down so
that being wrong is visible."* So this cell is designed in both plans and proven in neither.

**The review mechanism already exists in-house and should be generalised, not reinvented.**
`pnpm lint:permissions` is this loop working today on one slice: `MODULES` + `ROLES` are the
model, `PERMISSIONS.md` is emitted, it is checked in, and CI re-emits with `--check` so a
widened role cannot merge without appearing in the PR diff. Model → emit → commit →
diff-as-review, with CI making the human reading unskippable. `model.json` gets the same
treatment.

### 5.4 Emitted and authored files are disjoint sets

"Regenerate freely" is only safe if regeneration cannot destroy authored work. The rule:

> **The emitter never writes into a file a human or an AI has authored.**

Emitted stubs *import* authored bodies; they never contain them. Without this, every
regeneration is a three-way merge against hand-edited output, which is where systems of this
shape reliably die.

Wasp is the existence proof (§10.1), in its strongest form: generated code lands in
`.wasp/out/`, is regenerated on every build, is never edited, and is gitignored. Operation
bodies live in the developer's own `src/`, referenced from the spec. Preserve-authored-across-
regenerate is not a problem they solved — it is a problem they made impossible.

**CRM-EFF reached the same place independently, and their mechanism is better than the one I
first proposed here.** I had suggested tracking emitted files with a generation header and a
content hash, gated by re-emission. They did something cleaner:

> **Injection, never imports.** Generated code never imports hand-written code. Every generated
> assembly point is a factory — `createOperations(impl)`, `createModule(impl)`,
> `createBackend({impl})` — and the checked-in composition root does the wiring.

The consequence is that `gen/` is **genuinely disposable**: `rm -rf gen && npm run generate` is
proven in CI order by `prove.ts`, and `gen/` is gitignored. That recovers Wasp's property
without Wasp's constraint, and it makes the hash gate unnecessary — you cannot hand-edit a
directory that is deleted and rebuilt on every run.

Three seams carry it, and the third is the one worth stealing outright:

1. **The typed contract.** The generator derives an `Impl` interface from the model — one
   method per operation, input from the arguments, return from the return type — and the
   hand-written `impl/index.ts` ends in `satisfies Impl`. That single expression is the drift
   detector, and it failed usefully on first contact: `customer/get` returned four fields where
   the model promised ten, and `tsc` named the exact method. This is §8 rule 2 implemented
   better than "declare your returns" — the compiler enforces the join rather than a reviewer.
2. **Injection, never imports** (above).
3. **The composition root** — everything true about *this way of running the app* rather than
   about the app: seeding, ports, real auth replacing the dev principal seam, consumers the
   model cannot yet express. Their framing of it is the useful part: *"When something recurs
   here across apps, that is the signal it wants a directive — the root is where vocabulary
   candidates incubate."* A named place for not-yet-modelled things is what stops the model
   growing to swallow them prematurely.

Open for Substrat specifically: their `gen/` is disposable because generation runs before the
build. A vertical's `src/` is pushed by `substrat push`, so the same holds as long as
generation runs in CI ahead of the push — worth confirming rather than assuming.

## 6. Independence — what keeps the model honest

Every defect in #695 was found by two descriptions disagreeing. Generate the code from the
model and the code stops being independent: it is a *function* of the model. The second
opinion must then come from somewhere the model cannot reach, and the only candidate left is
the tests.

**Tests are written from `spec/concept.md`, never from the model and never by reading emitted
code.** A test derived from the model is a mirror: it agrees with a wrong model perfectly and
forever.

One mechanical rule that makes this checkable rather than aspirational, and which I do not
think is in any issue yet:

> **Scenario tests use literal inputs and assert literal outputs. They do not import the
> model's emitted types or schemas.**

A test that builds its input from the emitted Zod schema cannot disagree with that schema. A
test that writes `{ customerId: '01J…', hours: '2.5' }` as a literal can — and that is the
whole value. This is lintable.

**For #681's A/B specifically:** if the referee's tests are derived from the same model the
schema-first arm was built from, schema-first wins without being more correct — it will have
removed the only thing that could contradict it. Tokens-per-passing-build is the right metric
only if *passing* is judged against the concept.

**Measurement caution inherited from #695:** their first inference run reported 26% concrete /
55% opaque and that was a harness artefact — impls emitted with `input: any`, so every
`return { id: input.id }` inferred as `any`. Typed inputs moved it to 71% / 9% with no change
to the app. Any type-shaped measurement types the inputs first.

## 7. The document chain — features enter at the top or they do not enter

§4 gives the *model* a direction. The same direction governs the whole chain, and without it
§6's independence quietly fails:

```
requirement / feature  →  spec/concept.md  →  spec/model.ts  →  { emitted code, tests }
```

**The hole this closes.** §6 says tests are written from `concept.md`, and §4 says the model
changes only from upstream — but nothing so far keeps `concept.md` current. Add a feature by
editing the model directly, even for an entirely legitimate business reason, and the concept
silently stops being the source of truth. The tests derived from it then ratify yesterday's
product, and the independence collapses with nothing going red. That is §6's mirror problem
one level up.

**The rule:** a feature enters at `spec/concept.md`, or it does not enter. A model change
without a corresponding concept change is the signature of a downstream-authored feature.

**The mechanism:** a `git diff` over `spec/` — a `model.*` change with no `concept.md` change
in the same set fails the gate. This cannot prove the concept changed *correctly* (prose does
not diff for meaning), and it is not meant to. It is the third instance of the platform's
existing checkpoint pattern: *"Both are still a human reading a diff. CI going red is what
makes the reading unskippable; it is not itself the approval."* Read together, concept diff →
model diff → migration diff + permission diff are **one review at four altitudes**.

**Open, flagged not decided:** a `concept.md` describing 159 operations is unreadable, and an
unread document decays whatever the rule says. The lighter shape is to stop rewriting it —
the domain description stays small and stable, and features arrive as **append-only
requirement entries** with ids. "Is the concept current" then becomes "does every model
element trace to a requirement", which is lintable if operations cite one. The traceability
half may be over-engineering; the append-only half is worth taking regardless, because it is
what keeps the diff readable at 159 operations.

## 8. Two rules for the emitter itself

Generated code has *systematic* bugs where hand-written code has scattered ones. Net a win —
found once, fixed everywhere — but it relocates scrutiny onto the emitter, which now deserves
the review that used to be spread across 159 hand-written operations.

**Rule 1 — no silent defaults on anything load-bearing.** #695's 18 events emitting
`entityId: undefined` came from a *default*: the directive naming an event's entity id fell
back to `"id"`, and 18 mutations answer with `contractId` / `runId` / `workorderId` /
`instanceId`. Applied uniformly, silently, 18 times. So: **for anything that reaches an event,
a permission check, or a migration, absent means a compile error, never a guess.**

**Rule 2 — declared returns, not inferred ones.** Inference documents accidents. #695 found an
inferred type carrying `contacts?: undefined`, an artefact of an early return, which generation
would have cemented into the published API. Their adoption rule is the right one and is
already the platform's shape (`ApiOperationDoc.output` is "adopted incrementally"): **declare a
return where a caller branches on it**; leave large read projections opaque. They declared 54
of 159 and the split was itself informative.

## 9. Sequencing, mapped to issues

Ordered so each step is testable alone and #630's eval sweep referees each claimed win.

| # | step | issue |
|---|---|---|
| 0 | **`defineModel` + `model.json` emit + `--check`.** Valuable *outside the builder*: today `entityRelations`, `attachmentTargets`, `searchables` and `ui.entityViews` name entity types as four unvalidated `z.string()` fragments with no registry to check against — a typo'd `parentType` parses and silently kills a permission edge. Same defect class as #696. | **#697** |
| 1 | **Model phase in the builder** — `BuildPhase` gains `'model'`, `detectPhase` keys on `spec/model.ts`, write guards **both** directions (§4), a `model` gate (typecheck + emit + `--check`) added to `GateName`. | #680 |
| 2 | **Deterministic emitters** — migrations (pre-data), Zod, routes, manifest, permission registry, `ApiCatalog`. Build transcribes, never re-derives. | #681 |
| 3 | **Declared returns (Ask 2)** — `ApiOperationDoc.output` authored in the model. | #695 Ask 2 |
| 4 | **Diff classifier + phase gate** — additive vs breaking; pre/post-data regimes. | #115 + #685's parked tooling |
| 5 | **Lanes** — API and UI fork on the model. | #682, #683 |
| 6 | **ER diagram** — the approval checkpoint's picture, emitted from `model.json`. | #684 |

**Step 3 must precede step 5.** #685 makes the model the fork-point contract and says the UI
lane needs "Query/Mutation + inputs + Screens, nothing else" — but the UI lane consumes
*returns*, and returns are the least reliable thing in the model today: `output` is populated
nowhere in a 159-operation app, 11 return types were fictional, and only 54/159 were ever
declared. A UI lane forking on undeclared returns builds against an unchecked contract and
finds out at integration — the exact cost the split exists to avoid.

Wasp is the proof by contrast (§10.1). Their generated operation type is
`GetAllTasks<Input, Output>` — **`Input` and `Output` are supplied by the implementation**, not
by the declaration, and the typed client is generated from them. Full-stack type safety with
no declared contract at all. It works because there is exactly one description: client and
server are emitted from the same build, so they cannot disagree.

The price is precisely what we cannot pay. No contract exists before the handler is written,
so there is nothing to approve at the model checkpoint and nothing to diff for breaking
changes (§5) — and, decisively, **there is no fork point**: the client types derive from the
server implementation, so the UI cannot be built first or in parallel. *Wasp gets away without
declared returns because it has no lanes.* Anyone who wants #682/#683 has to pay for Ask 2
first.

**#684 is narrowed.** Its filter deliberately drops inputs and queries — but all 51 of #695's
schema defects (40 argument names, 11 return types) live in inputs and returns, while the part
the diagram renders is the part that measured exact. It is worth building as navigation and
shared vocabulary for the human approver; it is **not** the checkpoint that makes the model
safe, and it is not an AI input (SDL/JSON strictly dominates a lossy picture for a model).

## 10. Prior art

### 10.1 Wasp (wasp.sh) — read, findings folded in

An open-source full-stack framework: a declarative spec compiles to a React/Node/Prisma app,
with the developer writing only business logic. §2's four tiers, shipped, at 0.25 after several
years of real usage. Scope differs — Wasp generates the frontend and owns the runtime, where
Substrat is ecosystem-neutral on frontends (#122) and the vertical's `src/` is owned, tracked,
deployed code. So the borrowing is the **model → generator seam**, not the framework shape.

Five findings, each already folded into the section named:

1. **The notation migration is confirmed and recent → §3.** `main.wasp` DSL → TS config preview
   at 0.15 → TS Config retired for the function-based Wasp Spec at 0.24 → DSL dropped outright,
   announced June 2026. Reasons stated: *"more trouble than it was worth"*, *"started blocking
   us in further growing Wasp"*, needed a bespoke IDE extension, versus TS giving typecheck /
   autocomplete / go-to-definition free plus libraries, helpers, loops, multi-file specs.
   The strongest external evidence for §3's recommendation — and a caution that picking TS does
   not settle the notation question, since they revised the shape once inside it.
2. **They have no parse-without-execute story → §3.** A Turing-complete spec must be run to be
   read; the announcement does not address static analysis, and the only related mechanism is
   bundler magic resolving `with { type: "ref" }` imports without evaluating the target. Fine
   for trusted local developer code, disqualifying for a hosted console rendering a tenant's
   model. This is what promotes `model.json` from convenience to load-bearing.
3. **`.wasp/out/` is regenerated, never edited, gitignored → §5.4.** They did not solve
   preserve-authored-across-regenerate; they made it impossible. Our emitted tier must be
   *tracked yet never hand-edited*, a middle state they never occupied — hence the
   generation-header-plus-hash gate.
4. **Operation contracts are inferred from the implementation → §9.** `GetAllTasks<Input,
   Output>` takes its type arguments from the handler, and the typed client is generated from
   them. Full-stack type safety, no declared contract, **no fork point** — which is the
   external argument that Ask 2 must precede the lanes.
5. **`crud` shows the boundary holding, and how → §2.** When the generated default could not
   express the logic, they added `overrideFn` — a pointer to authored code — rather than
   enriching the declaration. That is the escape-hatch rule now written into §2.

Still open on Wasp, worth a look if the notation fork stays contested: how Prisma's
`migrate dev` vs `migrate deploy` split maps onto #115's phase gate, and whether their
schema-diff-to-migration-delta is reusable for §5's bottom-right cell.

### 10.2 CRM-EFF — read, findings folded in

`sdl/` in `Egeryds/CRM-EFF`: a 1,054-line README, a 25-directive language, an 88 KB schema of
the full app, a generator, a validator spec, and three harnesses. Substantially more finished
than #695 conveys. Findings against the six questions this section originally posed:

1. **Where SDL fought them → §3, and it decided the fork.** Not the three frictions in the
   issue — the real cost is structural: GraphQL directives cannot take type references, so
   every cross-reference is an unchecked string and the entire burden lands in a bespoke
   `validate` that is *"larger than the emitter"* and, in `future.md`, *"the most important
   tool in the toolchain."* Roughly its reference-integrity half is free in typed TS.
2. **The measurement harness → take as-is.** `differential.ts` mounts both REST surfaces over
   the same kernel, the same seeded world and the same invoke pipe, so *"everything downstream
   — auth, permission gates, the handlers, events, error mapping — is literally the same object
   in both runs, and any difference IS a difference in the generated surface."* `prove.ts`
   boots a real `SqliteScopeHost` from emitted parts only. App-independent, and the reason
   their claims are measurements rather than assertions.
3. **Emitter defaults → §8 rule 1 confirmed, and better evidence than one instance.** The
   `"id"` default is the famous one, but the pattern repeats: a TEXT `DEFAULT` emitted unquoted
   because the code sniffed whether a literal looked numeric instead of asking what the column
   stores; a multi-line description emitted into a `//` comment, orphaning the rest as code.
   Their framing is the keeper — *"the emitter changed the language"*: `entityIdFrom` exists
   **because** the emitter existed, and *"no amount of reading the schema would have found
   it."*
4. **Scale → unanswered, still open for #684.** The filtered entity-node count is not stated.
5. **Declared returns → §5.4.** Better than this plan had it: a generated `Impl` interface the
   hand-written impl must `satisfies`, so the compiler names the drifting method.
6. **A tier this plan lacked → §2, the question paid off.** Lifecycle vocabulary
   (`@retired`, `@renamedFrom`) is neither shape nor behaviour, and both are designed to be
   deleted after use.

Two more worth carrying back, neither anticipated:

- **`@erasable` is enforced by refusal, not emission** — a `@emits` payload naming a field
  marked erasable is rejected before a byte is written. A declaration whose whole job is to
  make something *impossible* has no tier in §2 either, and it is the check the PII posture
  rests on. Their own caveat: it matches on field *name* across all entities, so it is *"sound
  in the safe direction, but crude"* — the string weakness again.
- **The generator is stricter than the human.** It emits `id TEXT PRIMARY KEY NOT NULL`; the
  hand-written schema omits `NOT NULL`, and in SQLite a non-INTEGER primary key does not imply
  it. Every `vertical_*` table in that production app therefore accepts a NULL primary key.
  Latent rather than live (ids come from `ulid()`), and exactly the class of thing this layer
  is supposed to buy.

**What this plan has that theirs does not.** Their model is the top of the chain — there is no
concept or requirements layer above it, because they modelled an app that already existed and
the requirements were implicit in it. So §6 (test independence) and §7 (the document chain) have
no counterpart there, and their harnesses are *conformance* tools: `differential.ts` can only
ask "does generated match hand-written", which is a question that exists solely in the backward
direction. Forward, that second description has to be the tests, from the concept. That is the
gap their own closing paragraph points at — *"the slice proves the machinery runs. It does not
prove the vocabulary is right"* — and it is the one thing here that is genuinely ours to solve.

---

## 11. What this changes about how Substrat is explained

Not a design section. Recorded here because the model phase is what creates the thing the
current story is missing, and because it needs to land in `master-plan.md` §1 eventually —
that file declares itself canonical and every pitch artifact derivative of it, so amending the
marketing page first would be backwards.

**The positioning today is two-legged.** §1: *"a hosted substrate that owns those hard parts
and enforces them at runtime"*. The marketing page: "The hard parts, hosted" · "We build the
substrate. **You build the verticals.**" · "Code built on Substrat cannot: …" · "The ops a
platform team would build — built in." All of it is **runtime + hosting**, and all of it is
excellent. It stops at *"you build the verticals"* and never says **how**.

The word is not even available: `builder` appears ~20 times in the master plan and always means
the **customer** (the builder portal, builders of internal tools, builder-declared rules), never
the tool. `apps/builder` and "a builder" are different things in the same sentence today, and
that collision should be resolved before either is explained to anyone.

**The third leg, and why the combination is not a feature list.** Each leg is load-bearing for
the others:

1. **The fixed runtime is what makes the code generatable.** A general-purpose framework cannot
   ship a deterministic emitter for permissions, events and migrations, because every app
   invents its own shape. Substrat fixed the shape years earlier — every operation checks a
   permission, every mutation emits a fat event, migrations are append-only, engines own the
   invariants — so there is drastically less to *decide*. That is why the model is small and
   the emitter is deterministic, and #695 is the measurement: 159 operations, 164 routes,
   73 permission keys reproduced exactly, because their shape was never in question.

   CRM-EFF states the sharp version of this, and it is the best single idea in their write-up
   (§10.2). Nothing in their language annotates tenancy — no `@tenant`, no scope declaration,
   no validator check that anyone remembered — because *"scope is structural in the kernel: an
   operation is invoked through a stub that already is a tenant and a scope, and `ctx.sql`
   cannot reach another one. There is no annotation to forget, so there is no way to forget
   it."* Set against `@erasable`, a guarantee that holds only where someone wrote the
   annotation: **that is the difference between an invariant and a convention.** Their
   conclusion, which should be this plan's north star:

   > The best thing a modelling language can do with a rule is not need to express it.

   This turns the directive count into a **metric rather than a smell**. Their honest count is
   25, up from a 12-directive brief and down from a 35-directive first draft — and read this
   way, 25 directives are 25 places where the platform leaves a guarantee to convention. The
   roadmap that follows is: push guarantees *down* into the kernel to delete vocabulary. #696
   is a live instance — `@emits`/`@consumes` carry weight partly because the kernel's event
   seam is `Record<string, ConsumerHandler>` with `payload: unknown`. Type that seam and some
   of the directive disappears into the compiler.
2. **Owning the hosting is what makes regeneration safe.** "Change the model and regenerate" is
   a real offer only where someone owns the data lifecycle — §5's phase gate (#115), the PITR
   bookmark before migrations, in-place deploys, per-PR preview forks. Wasp can say "regenerate
   freely" because it has no data and no tenants; we can say it and mean it in production.
3. **Owning the writing process is what keeps the runtime's guarantees true.** The "cannot"
   list is enforced at runtime, but boundary-lint, the permission diff, the gates and the model
   phase are what stop the generator from trying. §2's own argument — *prompting is not
   enforcement* — earns its teeth above the line as well as below it.

The compressed form, which the current pitch has no sentence for:

> **The substrate is fixed, therefore the app is mostly derivable.** The constraint is the
> feature.

**Borrow from Wasp: three named artifacts, one role each.** Their explanation works because
`main.wasp.ts` / `schema.prisma` / `src/` is teachable in one diagram. Ours already falls out
of §2:

| artifact | says | written by |
|---|---|---|
| `spec/concept.md` | what the business is | human, approved |
| `spec/model.ts` | what exists | human-approved, AI-drafted |
| `src/` | how it behaves | AI, gated |
| *(the substrate)* | tenancy, permissions, audit, events, migrations, hosting | **nobody — it is already there** |

The fourth row is the differentiator and the one Wasp has no equivalent for. Second thing worth
stealing: in their story the generated tier is *invisible*. Ours cannot be — it is tracked and
deployed (§5.4) — but it should be **unremarkable**. A pitch that makes the reader think about
generated code is doing the wrong job.
