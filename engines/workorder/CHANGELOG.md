# @substrat-run/engine-workorder

## 0.6.5

### Patch Changes

- Updated dependencies [d3c6d31]
  - @substrat-run/contracts@0.78.0
  - @substrat-run/kernel@0.78.0

## 0.6.4

### Patch Changes

- Updated dependencies [cbc4538]
  - @substrat-run/contracts@0.77.0
  - @substrat-run/kernel@0.77.0

## 0.6.3

### Patch Changes

- @substrat-run/contracts@0.76.0
- @substrat-run/kernel@0.76.0

## 0.6.2

### Patch Changes

- Updated dependencies [89c2113]
  - @substrat-run/kernel@0.75.0
  - @substrat-run/contracts@0.75.0

## 0.6.1

### Patch Changes

- Updated dependencies [f8bf35e]
  - @substrat-run/contracts@0.74.0
  - @substrat-run/kernel@0.74.0

## 0.6.0

### Minor Changes

- 3b8533d: **zod is now a peer dependency.** Install it alongside these packages:

  ```sh
  npm install zod@^4.4.0
  ```

  Every package here hands out zod schemas that a consumer parses with, composes
  into their own, and that `mountOperations` reads `_zod.def` off to find pinned
  literals. Two copies of zod in one tree means an object made by one is not
  recognised by the other, and the symptom — `expected a Zod schema` — points
  nowhere near the cause. A peer dependency says _use the consumer's copy_.

  The declared range is `^4.4.0` rather than the exact version this repo builds
  against: a peer range should state what the code supports, and pinning it to
  `^4.4.3` would refuse a consumer on 4.4.0 for no reason.

  **A defect this found.** `@substrat-run/contract-tests` shipped **130
  `import("zod")` references in its published `.d.ts` while declaring zod
  nowhere.** It resolved only because contracts had zod as a regular dependency,
  which hoisted a copy into view — not a dependency, a coincidence. It now declares
  it. Two more of the same class turned up when the tree shifted: packages using
  `setTimeout`/`atob`/`btoa` — globals absent from `lib: ES2023` — compiling on an
  ambient `@types/node` nobody had declared.

  That is the general rule now enforced by `pnpm lint:deps`
  (`tools/declared-deps.mjs`) in CI: **every module a package references, in its
  source or its emitted `.d.ts`, must be one it declared.** The `.d.ts` half is the
  sharp one — TypeScript writes the original specifier into declarations however
  the source imported it, so re-exporting `z` through contracts still emits
  `import("zod")` into a dependent's types.

  **Why a lint rather than pnpm's own enforcement**, measured rather than assumed:
  `autoInstallPeers` (pnpm's default) turns a peer conflict into a silent second
  copy — with contracts peer-requiring `^4.4.3` and a consumer declaring `^3.23.0`,
  pnpm reported nothing, and `zod` did not appear once in the peer report even
  under `--strict-peer-dependencies`. And pnpm's peer checking does not reach
  `workspace:` links at all. Full reasoning in `docs/architecture/dependency-policy.md`.

  Internally, shared versions now come from a pnpm `catalog:` so one version is a
  single edit. The `pnpm` settings block moved from `package.json` to
  `pnpm-workspace.yaml`, which is where pnpm 10 reads it — it had been ignored,
  with `overrides` surviving only because they were baked into the lockfile.

  Closes #742.

### Patch Changes

- Updated dependencies [3b8533d]
  - @substrat-run/contracts@0.73.0
  - @substrat-run/kernel@0.73.0

## 0.5.0

### Minor Changes

- 19fb697: The workorder engine declares its operation surface, and a route binding becomes
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
    "workorder/get": { method: "GET", path: "/workorders/{orderId}" },
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

### Patch Changes

- Updated dependencies [f869541]
- Updated dependencies [f869541]
- Updated dependencies [19fb697]
- Updated dependencies [f869541]
- Updated dependencies [717600e]
- Updated dependencies [46b1cac]
- Updated dependencies [9208b4e]
  - @substrat-run/kernel@0.72.0
  - @substrat-run/contracts@0.72.0

## 0.4.3

### Patch Changes

- Updated dependencies [ce44df8]
- Updated dependencies [ce44df8]
  - @substrat-run/contracts@0.71.0
  - @substrat-run/kernel@0.71.0

## 0.4.2

### Patch Changes

- Updated dependencies [9bb7975]
  - @substrat-run/contracts@0.70.0
  - @substrat-run/kernel@0.70.0

## 0.4.1

### Patch Changes

- Updated dependencies [17a82ec]
  - @substrat-run/contracts@0.69.0
  - @substrat-run/kernel@0.69.0

## 0.4.0

### Minor Changes

- aaf41b8: **BREAKING:** `foreignChildOf` / `foreignChildren` collapse into `relations`, with both sides checked.

  Those two existed for one reason: a relation edge naming an engine's entity could
  not be checked, so the pair at least made _which half_ was unchecked visible. Now
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

- b9dbda9: **BREAKING:** `EntityDef.parent` becomes `parents`, and takes an array.

  `entityRelations` is an **allowlist, not an assertion**. The kernel accumulates
  permitted parents into a _set_ per entity type
  (`adapter-sqlite/src/index.ts:1348-1352`) and `ctx.link` checks membership — so an
  entity legitimately has more than one, and two already do:

  | entity        | parents                 | declared by                 |
  | ------------- | ----------------------- | --------------------------- |
  | `reservation` | `resource`, `member`    | engine-booking, rally       |
  | `protocol`    | `workorder`, `employee` | callout/handlebar, meridian |

  Singular `parent` said _"the parent"_, which is not what the kernel means and
  cannot express those. It had not bitten only because each parent is declared by a
  different module, so no single registry needed both.

  Renamed rather than widened to `Names | readonly Names[]`: a union leaves
  consumers handling two shapes forever, and the plural name is the one that is
  true. Migration is mechanical — `parent: 'customer'` → `parents: ['customer']` —
  and the emitted `model.json` carries an array now, so the artifact of record has
  one shape for anything reading it.

  ***

  **engine-workorder declares its entity and exports its row schema.**

  A composing vertical could not get the entity-type constant its permission-walk
  edges name, nor a Zod schema for the row a declared operation returns — the same
  two gaps engine-protocol just closed. `OrderRow` is now derived from the registry
  rather than written beside it.

  One entity, three tables: `workorder` is what the platform points at; time
  entries and material lines are rows this engine owns and totals.

  It declares **no `parents`**, deliberately. The parent is the vertical's noun —
  Callout takes the manifest's `facility`, Handlebar hangs work orders off a bike —
  and the manifest's hand-written `facility` edge stays until foreign entity names
  become checkable.

- 09852a9: `WorkOrder` becomes schema-first, and the row schema's docs stop overclaiming.

  `workorderRow` was described as "the row shape, for a vertical declaring an
  operation that returns one". The first half is true and the second is not: the
  engine **stores** `facility_type` / `facility_id` as two snake_case columns and
  **publishes** one `EntityRef` in camelCase. A vertical declaring
  `output: workorderRow` would have been declaring the wrong shape, and confidently.

  `workOrder` is the published type, exported as a Zod schema with the interface
  derived from it — matching `billableLine` and `createWorkOrderInput`, which were
  already schema-first. `status` is taken from the entity registry, so storage and
  domain cannot disagree about the state set.

  The row schema keeps its place; its documentation now says what it is, and names
  `workOrder` as what operations return.

### Patch Changes

- Updated dependencies [60789c8]
- Updated dependencies [aaf41b8]
- Updated dependencies [a05cd4d]
- Updated dependencies [b9dbda9]
- Updated dependencies [4eb532b]
  - @substrat-run/contracts@0.68.0
  - @substrat-run/kernel@0.68.0

## 0.3.65

### Patch Changes

- Updated dependencies [5601fa9]
- Updated dependencies [81a8c62]
- Updated dependencies [746a885]
- Updated dependencies [ee95fd6]
  - @substrat-run/contracts@0.67.0
  - @substrat-run/kernel@0.67.0

## 0.3.64

### Patch Changes

- Updated dependencies [954668b]
  - @substrat-run/kernel@0.66.0
  - @substrat-run/contracts@0.66.0

## 0.3.63

### Patch Changes

- Updated dependencies [daae585]
  - @substrat-run/contracts@0.65.0
  - @substrat-run/kernel@0.65.0

## 0.3.62

### Patch Changes

- Updated dependencies [c19e371]
  - @substrat-run/contracts@0.64.0
  - @substrat-run/kernel@0.64.0

## 0.3.61

### Patch Changes

- Updated dependencies [5e71e1c]
  - @substrat-run/kernel@0.63.0
  - @substrat-run/contracts@0.63.0

## 0.3.60

### Patch Changes

- Updated dependencies [39807d7]
  - @substrat-run/contracts@0.62.0
  - @substrat-run/kernel@0.62.0

## 0.3.59

### Patch Changes

- Updated dependencies [ee491fc]
  - @substrat-run/contracts@0.61.0
  - @substrat-run/kernel@0.61.0

## 0.3.58

### Patch Changes

- Updated dependencies [92e9e03]
- Updated dependencies [3ee5903]
  - @substrat-run/contracts@0.60.0
  - @substrat-run/kernel@0.60.0

## 0.3.57

### Patch Changes

- @substrat-run/contracts@0.59.0
- @substrat-run/kernel@0.59.0

## 0.3.56

### Patch Changes

- Updated dependencies [daab0d5]
- Updated dependencies [778f48a]
  - @substrat-run/contracts@0.58.0
  - @substrat-run/kernel@0.58.0

## 0.3.55

### Patch Changes

- Updated dependencies [c9911ea]
  - @substrat-run/contracts@0.57.0
  - @substrat-run/kernel@0.57.0

## 0.3.54

### Patch Changes

- Updated dependencies [4eb90ca]
- Updated dependencies [c1faa15]
  - @substrat-run/contracts@0.56.0
  - @substrat-run/kernel@0.56.0

## 0.3.53

### Patch Changes

- @substrat-run/contracts@0.55.0
- @substrat-run/kernel@0.55.0

## 0.3.52

### Patch Changes

- Updated dependencies [b387919]
- Updated dependencies [fa81319]
  - @substrat-run/contracts@0.54.0
  - @substrat-run/kernel@0.54.0

## 0.3.51

### Patch Changes

- Updated dependencies [0148b77]
- Updated dependencies [88e2efa]
  - @substrat-run/contracts@0.53.0
  - @substrat-run/kernel@0.53.0

## 0.3.50

### Patch Changes

- Updated dependencies [0e45268]
  - @substrat-run/contracts@0.52.0
  - @substrat-run/kernel@0.52.0

## 0.3.49

### Patch Changes

- @substrat-run/contracts@0.51.0
- @substrat-run/kernel@0.51.0

## 0.3.48

### Patch Changes

- Updated dependencies [fa85dd8]
- Updated dependencies [5063d1c]
- Updated dependencies [d7d8fa9]
  - @substrat-run/contracts@0.50.0
  - @substrat-run/kernel@0.50.0

## 0.3.47

### Patch Changes

- Updated dependencies [a13c8fb]
- Updated dependencies [f11a961]
  - @substrat-run/contracts@0.49.0
  - @substrat-run/kernel@0.49.0

## 0.3.46

### Patch Changes

- Updated dependencies [791e4fd]
  - @substrat-run/contracts@0.48.0
  - @substrat-run/kernel@0.48.0

## 0.3.45

### Patch Changes

- Updated dependencies [6a7b4a8]
- Updated dependencies [a90dec0]
- Updated dependencies [3fcf34b]
  - @substrat-run/kernel@0.47.0
  - @substrat-run/contracts@0.47.0

## 0.3.44

### Patch Changes

- @substrat-run/contracts@0.46.0
- @substrat-run/kernel@0.46.0

## 0.3.43

### Patch Changes

- Updated dependencies [846af24]
  - @substrat-run/contracts@0.45.0
  - @substrat-run/kernel@0.45.0

## 0.3.42

### Patch Changes

- Updated dependencies [3246681]
  - @substrat-run/kernel@0.44.0
  - @substrat-run/contracts@0.44.0

## 0.3.41

### Patch Changes

- @substrat-run/contracts@0.43.0
- @substrat-run/kernel@0.43.0

## 0.3.40

### Patch Changes

- Updated dependencies [b0355b4]
- Updated dependencies [b0355b4]
  - @substrat-run/kernel@0.42.0
  - @substrat-run/contracts@0.42.0

## 0.3.39

### Patch Changes

- Updated dependencies [d222905]
  - @substrat-run/contracts@0.41.0
  - @substrat-run/kernel@0.41.0

## 0.3.38

### Patch Changes

- Updated dependencies [d96269e]
- Updated dependencies [3c77f64]
- Updated dependencies [d59a515]
  - @substrat-run/kernel@0.40.0
  - @substrat-run/contracts@0.40.0

## 0.3.37

### Patch Changes

- Updated dependencies [3cf4e3b]
  - @substrat-run/contracts@0.39.0
  - @substrat-run/kernel@0.39.0

## 0.3.36

### Patch Changes

- Updated dependencies [5afb162]
  - @substrat-run/contracts@0.38.0
  - @substrat-run/kernel@0.38.0

## 0.3.35

### Patch Changes

- @substrat-run/contracts@0.37.0
- @substrat-run/kernel@0.37.0

## 0.3.34

### Patch Changes

- @substrat-run/contracts@0.36.0
- @substrat-run/kernel@0.36.0

## 0.3.33

### Patch Changes

- Updated dependencies [17eec41]
  - @substrat-run/contracts@0.35.0
  - @substrat-run/kernel@0.35.0

## 0.3.32

### Patch Changes

- Updated dependencies [ab637f0]
  - @substrat-run/contracts@0.34.0
  - @substrat-run/kernel@0.34.0

## 0.3.31

### Patch Changes

- Updated dependencies [6d3429e]
  - @substrat-run/contracts@0.33.0
  - @substrat-run/kernel@0.33.0

## 0.3.30

### Patch Changes

- Updated dependencies [99af6b6]
- Updated dependencies [070f4dc]
  - @substrat-run/contracts@0.32.0
  - @substrat-run/kernel@0.32.0

## 0.3.29

### Patch Changes

- Updated dependencies [fbf0704]
- Updated dependencies [41d01f6]
- Updated dependencies [50d9260]
- Updated dependencies [0e9eba7]
  - @substrat-run/contracts@0.31.0
  - @substrat-run/kernel@0.31.0

## 0.3.28

### Patch Changes

- Updated dependencies [a698959]
- Updated dependencies [67be7c7]
  - @substrat-run/contracts@0.30.0
  - @substrat-run/kernel@0.30.0

## 0.3.27

### Patch Changes

- @substrat-run/contracts@0.29.0
- @substrat-run/kernel@0.29.0

## 0.3.26

### Patch Changes

- @substrat-run/contracts@0.28.0
- @substrat-run/kernel@0.28.0

## 0.3.25

### Patch Changes

- Updated dependencies [6901c16]
  - @substrat-run/contracts@0.27.0
  - @substrat-run/kernel@0.27.0

## 0.3.24

### Patch Changes

- Updated dependencies [2bdd22b]
  - @substrat-run/contracts@0.26.0
  - @substrat-run/kernel@0.26.0

## 0.3.23

### Patch Changes

- Updated dependencies [e612b98]
- Updated dependencies [caedb1c]
- Updated dependencies [f0df69a]
  - @substrat-run/contracts@0.25.0
  - @substrat-run/kernel@0.25.0

## 0.3.22

### Patch Changes

- Updated dependencies [72b1128]
- Updated dependencies [1cfce31]
- Updated dependencies [aa503c2]
- Updated dependencies [5a3ef82]
- Updated dependencies [4c275df]
- Updated dependencies [d4bf108]
  - @substrat-run/contracts@0.24.0
  - @substrat-run/kernel@0.24.0

## 0.3.21

### Patch Changes

- Updated dependencies [6a86837]
  - @substrat-run/contracts@0.23.0
  - @substrat-run/kernel@0.23.0

## 0.3.20

### Patch Changes

- Updated dependencies [bc6d0fa]
  - @substrat-run/contracts@0.22.0
  - @substrat-run/kernel@0.22.0

## 0.3.19

### Patch Changes

- @substrat-run/contracts@0.21.0
- @substrat-run/kernel@0.21.0

## 0.3.18

### Patch Changes

- Updated dependencies [d18d788]
- Updated dependencies [a39a024]
  - @substrat-run/contracts@0.20.0
  - @substrat-run/kernel@0.20.0

## 0.3.17

### Patch Changes

- Updated dependencies [b4a6bee]
  - @substrat-run/contracts@0.19.0
  - @substrat-run/kernel@0.19.0

## 0.3.16

### Patch Changes

- Updated dependencies [d18a247]
  - @substrat-run/contracts@0.18.0
  - @substrat-run/kernel@0.18.0

## 0.3.15

### Patch Changes

- @substrat-run/contracts@0.17.0
- @substrat-run/kernel@0.17.0

## 0.3.14

### Patch Changes

- Updated dependencies [b23c0a7]
- Updated dependencies [81e9408]
  - @substrat-run/contracts@0.16.0
  - @substrat-run/kernel@0.16.0

## 0.3.13

### Patch Changes

- Updated dependencies [cd32011]
- Updated dependencies [ec89a88]
  - @substrat-run/contracts@0.15.0
  - @substrat-run/kernel@0.15.0

## 0.3.12

### Patch Changes

- cb6131c: docs: point every published package's `homepage` at its substrat.net page and
  swap the stale `substrat.ahlstrand.es` doc links in READMEs for `substrat.net`.
  Add the three missing READMEs (`engine-booking`, `cli`, `control-plane-api`).
  Metadata/docs only — no code or API change; a republish is needed for the
  updated README + homepage to render on npm.
- Updated dependencies [cb6131c]
  - @substrat-run/contracts@0.14.1
  - @substrat-run/kernel@0.14.1

## 0.3.11

### Patch Changes

- Updated dependencies [6a7768a]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
- Updated dependencies [1022c15]
  - @substrat-run/contracts@0.14.0
  - @substrat-run/kernel@0.14.0

## 0.3.10

### Patch Changes

- Updated dependencies [74c9d7b]
  - @substrat-run/kernel@0.13.0
  - @substrat-run/contracts@0.13.0

## 0.3.9

### Patch Changes

- 0572a3b: **Typecheck on the native (Go) TypeScript compiler — `typescript` 5.6 → 7.**

  TypeScript 7 (the native compiler, formerly the `tsgo`/`@typescript/native-preview`
  rewrite) is now GA as `typescript@latest`. The binary is still `tsc`, so every package's
  `tsc -p … --noEmit` script is unchanged — only the toolchain pin moves. No source or
  public API changes; this bumps the published packages solely because their build now runs
  through the native compiler.

  Full-workspace `pnpm -r typecheck` drops to ~3s wall; per-package the native checker is
  roughly an order of magnitude faster (kernel 1.33s → 0.07s, control-plane-api 1.50s →
  0.12s, engine-invoicing 0.91s → 0.06s on this machine).

  Two migration deltas TS7's stricter resolution surfaced (both green on 5.6, red on 7):

  - **CSS side-effect imports (`TS2882`).** `import './ui.css'` in the six Vite app/admin
    surfaces now needs an ambient declaration. Fixed the way `demos/meridian/app` already
    did it — `"types": ["vite/client"]` in each app `tsconfig.json` (vite/client declares
    `*.css`) — rather than adding a stray `vite-env.d.ts`.
  - **`boundary-lint` node globals (`TS2584`/`TS2591`).** The linter CLI's `process`,
    `console`, and `node:fs`/`node:path` imports stopped resolving because the base tsconfig
    leaves `types` unset and TS7 no longer implicitly pulls in `@types/node` here. Added an
    explicit `"types": ["node"]` to `packages/boundary-lint/tsconfig.json`.

  Note: TS7 is a major bump that drops deprecated 5.x behavior. Editors should run their
  TS Server on 7 to keep CLI and IDE diagnostics aligned.

- Updated dependencies [73c0cdb]
- Updated dependencies [1dff2bd]
- Updated dependencies [66e752b]
- Updated dependencies [0572a3b]
  - @substrat-run/contracts@0.12.0
  - @substrat-run/kernel@0.12.0

## 0.3.8

### Patch Changes

- Updated dependencies [7e17b16]
- Updated dependencies [858912e]
- Updated dependencies [e4db6ed]
- Updated dependencies [e4db6ed]
  - @substrat-run/kernel@0.11.0
  - @substrat-run/contracts@0.11.0

## 0.3.7

### Patch Changes

- Updated dependencies [9c1f0bb]
- Updated dependencies [113160a]
- Updated dependencies [3fb38da]
- Updated dependencies [2becfd5]
- Updated dependencies [d881f75]
  - @substrat-run/contracts@0.10.0
  - @substrat-run/kernel@0.10.0

## 0.3.6

### Patch Changes

- Updated dependencies [27872cc]
  - @substrat-run/kernel@0.9.0
  - @substrat-run/contracts@0.9.0

## 0.3.5

### Patch Changes

- @substrat-run/contracts@0.8.0
- @substrat-run/kernel@0.8.0

## 0.3.4

### Patch Changes

- Updated dependencies [c54637b]
- Updated dependencies [8c48c93]
- Updated dependencies [33fb5dd]
  - @substrat-run/contracts@0.7.0
  - @substrat-run/kernel@0.7.0

## 0.3.3

### Patch Changes

- @substrat-run/contracts@0.6.0
- @substrat-run/kernel@0.6.0

## 0.3.2

### Patch Changes

- @substrat-run/contracts@0.5.0
- @substrat-run/kernel@0.5.0

## 0.3.1

### Patch Changes

- Updated dependencies [6900431]
  - @substrat-run/contracts@0.4.0
  - @substrat-run/kernel@0.4.0

## 0.3.0

### Minor Changes

- 5dd4085: Zod 4, and `contracts` re-exports `z` — closing a live from-scratch trap

  **The trap.** The published packages depend on `zod ^3.25.0` while `pnpm add zod`
  — which getting-started told users to run — installs Zod 4. pnpm resolves both:
  Zod 3 nested for our packages, Zod 4 for the user. Two copies, both "correct".
  Zod schemas do not compose across majors, so the moment a user wrote the pattern
  CLAUDE.md mandates ("operation inputs go through Zod schemas at the boundary")
  composing a contracts schema into their own —

                                                                                                                                                              z.object({ facility: entityRef, unitPrice: money })

  — it failed at RUNTIME with `Invalid element at key "facility": expected a Zod
schema`, an error pointing nowhere near the cause. Not an exotic pattern: it is
  what `engines/workorder` itself does (`unitPrice: money`, `facility: entityRef`),
  so anyone copying the reference hit it immediately. Found by building a vertical
  from scratch against the published packages — the flow the docs describe and
  nobody had walked.

  **Two fixes, because they solve different halves.**

  1. **Zod 4 everywhere.** Aligns with what the ecosystem installs by default, so a
     user who reaches for `zod` gets our major. No code changes were needed — the
     schema subset in use (`z.object`, `.regex`, `.brand`, `.min`, `.optional`,
     `z.infer`) is stable across the major, and the one `z.record` was already the
     2-arg form Zod 4 requires. Build, typecheck, and the full suite pass unchanged.
  2. **`contracts` re-exports `z`.** The durable half: importing `z` from
     `@substrat-run/contracts` means the consumer never installs zod at all, so the
     versions cannot diverge. Fix 1 makes the trap dormant; fix 2 keeps it dormant
     when Zod 5 ships.

  `zod` is dropped from the getting-started install line; docs and the `substrat`
  skill both import `z` from contracts.

  **Breaking for consumers on Zod 3** — deliberately taken now, while there are
  effectively none, rather than later when there are.

  **Still open:** making `zod` a `peerDependency`. Contracts' schemas are part of
  its public API — consumers are meant to compose them, so their copy must be ours
  — which is textbook peer. As a plain dependency it nests silently instead of
  failing at install. Left as a separate call.

### Patch Changes

- Updated dependencies [5dd4085]
  - @substrat-run/contracts@0.3.0
  - @substrat-run/kernel@0.3.0

## 0.2.0

### Minor Changes

- 604883b: Manifest-declared operation guards and operation withdrawal — compliance gates a reviewer can enumerate.

  A vertical declares an unconditional gate in its manifest (`guards: [{ before, predicate, config }]`); a module contributes the named predicate (`predicates` on `ModuleRegistration`, typed `GuardPredicate`); the kernel evaluates it inside the guarded operation's own transaction, before the handler, failing closed. `withdraws` lets a vertical suppress an engine's default operation binding so the guarded wrapper is the only door — without it a gate is reviewable but bypassable. Both are optional and additive: existing manifests parse and behave unchanged.

  The protocol engine gains a `protocol/all-signed` predicate and the `requireCountersigned` in-scope function; the work-order engine exports `closeWorkOrder` as an in-scope function (its `workorder/close` operation is now the thin binding). The scope-host contract suite covers guards and withdrawal, so every adapter must implement both.

### Patch Changes

- Updated dependencies [604883b]
  - @substrat-run/contracts@0.2.0
  - @substrat-run/kernel@0.2.0

## 0.1.0

### Minor Changes

- 7583dab: First end-to-end feature set: the kernel deltas that carry a running vertical.

  - **Contracts**: relationship tuples with proof-path `Decision`s (an unexplained allow is
    unrepresentable), entity-narrowed capability grants, `entityRelations` and `ui`
    contributions on the module manifest, shared `money` schema with exact decimal
    arithmetic, attachment `visibility` classification.
  - **Kernel**: `registerModule` (manifest + migrations + operations + consumers),
    `OperationContext.link`, entity-aware `PermissionChecker`, `HostAdmin` surface for
    roles/assignments/grants/membership, `assertAllowed`/`PermissionDenied`.
  - **adapter-sqlite**: built-in constrained tuple permission engine (fixed four-rule
    algebra, proof paths, grant expiry, org membership), per-scope migration journal
    (lazy on wake, crash-safe), per-operation transactions (writes and emitted events
    commit or roll back together), local at-least-once event dispatch with a kernel
    delivery journal and system-actor consumer contexts.
  - **contract-tests**: atomicity, migration-journal, dispatch exactly-once, and tuple
    permission suites — every adapter must pass all of them unchanged.
  - **Engines**: first releases of `@substrat-run/engine-workorder` (state machine, append-only
    time/material, fat completion events) and `@substrat-run/engine-invoicing` (event-consuming
    snapshot fakturaunderlag with provenance, immutable once exported).

### Patch Changes

- Updated dependencies [7583dab]
  - @substrat-run/contracts@0.1.0
  - @substrat-run/kernel@0.1.0
