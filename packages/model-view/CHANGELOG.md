# @substrat-run/model-view

## 0.2.3

### Patch Changes

- Updated dependencies [e7115b2]
- Updated dependencies [3e67ebe]
  - @substrat-run/contracts@0.102.0

## 0.2.2

### Patch Changes

- Updated dependencies [b61c4d5]
- Updated dependencies [306b893]
  - @substrat-run/contracts@0.101.0

## 0.2.1

### Patch Changes

- Updated dependencies [0cd3055]
- Updated dependencies [4b159da]
- Updated dependencies [d1a5a58]
- Updated dependencies [8912fb8]
- Updated dependencies [6b3e466]
  - @substrat-run/contracts@0.100.0

## 0.2.0

### Minor Changes

- 28a82c0: The entity model ships with a push, and the dashboard renders it (#1214). A vertical with
  a checked-in `model.json` (the artifact `pnpm lint:model` emits, #697) now carries it in
  the deploy manifest — metadata beside `envSpec` and `surfaces`, in no digest — and the
  dashboard's new Model tab renders the DEPLOYED version's model: the ER diagram, the entity
  cards, and the declared lifecycles (#844), for exactly the version the app runs.

  The rendering core moved out of the CLI into a new published package,
  `@substrat-run/model-view`: the pure `model.json → self-contained HTML` half of
  `substrat model view` (#756), with no `node:*` imports, so the CLI, the dashboard worker
  and the browser bundle all draw the same page from the same artifact. `substrat model
view` behaves exactly as before. Contracts gains `emittedModel` — the Zod twin of the
  `EmittedModel` interface — so the control plane re-parses the model at the trust boundary
  instead of trusting the CLI's serialization, and the control plane grows the matching
  owner-narrowed read: `GET /verticals/:slug/versions/:id/model`.

  A vertical with no `model.json` pushes exactly as before, and versions pushed by an older
  CLI stay readable — the tab shows an empty state pointing at the next push.

### Patch Changes

- Updated dependencies [e398034]
- Updated dependencies [28a82c0]
- Updated dependencies [d124e9a]
- Updated dependencies [8e29866]
- Updated dependencies [02793d9]
  - @substrat-run/contracts@0.99.0
