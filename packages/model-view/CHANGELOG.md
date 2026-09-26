# @substrat-run/model-view

## 0.2.24

### Patch Changes

- @substrat-run/contracts@0.122.1

## 0.2.23

### Patch Changes

- Updated dependencies [0803833]
  - @substrat-run/contracts@0.122.0

## 0.2.22

### Patch Changes

- Updated dependencies [a235648]
- Updated dependencies [6fc9950]
- Updated dependencies [48fea30]
- Updated dependencies [45b927e]
  - @substrat-run/contracts@0.121.0

## 0.2.21

### Patch Changes

- @substrat-run/contracts@0.120.0

## 0.2.20

### Patch Changes

- Updated dependencies [bb10d6d]
- Updated dependencies [929ec09]
- Updated dependencies [a9cfc4a]
- Updated dependencies [2c65b67]
- Updated dependencies [8009cd1]
- Updated dependencies [b080e0f]
- Updated dependencies [e7113ea]
  - @substrat-run/contracts@0.119.0

## 0.2.19

### Patch Changes

- Updated dependencies [030fafd]
- Updated dependencies [56a931b]
- Updated dependencies [429cc84]
  - @substrat-run/contracts@0.118.0

## 0.2.18

### Patch Changes

- Updated dependencies [6504a99]
- Updated dependencies [aabc227]
- Updated dependencies [fb37a3e]
- Updated dependencies [44299a1]
- Updated dependencies [d7eb089]
- Updated dependencies [105a4c3]
- Updated dependencies [a8c2c64]
- Updated dependencies [2fa5147]
- Updated dependencies [1f223f5]
  - @substrat-run/contracts@0.117.0

## 0.2.17

### Patch Changes

- Updated dependencies [e22db55]
- Updated dependencies [a67c59b]
- Updated dependencies [45d2f15]
- Updated dependencies [e99332e]
  - @substrat-run/contracts@0.116.0

## 0.2.16

### Patch Changes

- Updated dependencies [1a6fe4d]
  - @substrat-run/contracts@0.115.0

## 0.2.15

### Patch Changes

- Updated dependencies [f58aa74]
  - @substrat-run/contracts@0.114.0

## 0.2.14

### Patch Changes

- Updated dependencies [c146761]
- Updated dependencies [c3c92e9]
- Updated dependencies [2fc7187]
- Updated dependencies [7e6f925]
  - @substrat-run/contracts@0.113.0

## 0.2.13

### Patch Changes

- Updated dependencies [c697b15]
- Updated dependencies [db6a96f]
- Updated dependencies [221f94a]
  - @substrat-run/contracts@0.112.0

## 0.2.12

### Patch Changes

- Updated dependencies [f08bfc4]
- Updated dependencies [aaafae3]
- Updated dependencies [1b2506c]
  - @substrat-run/contracts@0.111.0

## 0.2.11

### Patch Changes

- Updated dependencies [a195037]
- Updated dependencies [8758949]
- Updated dependencies [d05689d]
- Updated dependencies [0257dbd]
- Updated dependencies [cb88aa1]
  - @substrat-run/contracts@0.110.0

## 0.2.10

### Patch Changes

- Updated dependencies [7aa3ea5]
- Updated dependencies [1e175ce]
  - @substrat-run/contracts@0.109.0

## 0.2.9

### Patch Changes

- Updated dependencies [5cf7ae4]
- Updated dependencies [44b53e4]
  - @substrat-run/contracts@0.108.0

## 0.2.8

### Patch Changes

- Updated dependencies [4a6c4c3]
  - @substrat-run/contracts@0.107.0

## 0.2.7

### Patch Changes

- @substrat-run/contracts@0.106.0

## 0.2.6

### Patch Changes

- @substrat-run/contracts@0.105.0

## 0.2.5

### Patch Changes

- Updated dependencies [dd999a9]
  - @substrat-run/contracts@0.104.0

## 0.2.4

### Patch Changes

- Updated dependencies [dc9995c]
- Updated dependencies [adf6bfb]
  - @substrat-run/contracts@0.103.0

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
