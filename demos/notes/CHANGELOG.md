# @substrat-run/demo-notes

## 0.2.2

### Patch Changes

- Updated dependencies [53679f8]
- Updated dependencies [5f0276e]
- Updated dependencies [d08db0d]
- Updated dependencies [2c4a11d]
- Updated dependencies [20cdb03]
- Updated dependencies [d62a936]
- Updated dependencies [d93c0de]
- Updated dependencies [eb34bb2]
- Updated dependencies [12ea0e6]
- Updated dependencies [f648aa8]
  - @substrat-run/contracts@0.200.0
  - @substrat-run/kernel@0.200.0
  - @substrat-run/adapter-sqlite@0.200.0
  - @substrat-run/vertical-host@0.200.0
  - @substrat-run/demo-todo@1.0.13
  - @substrat-run/dev-issuer@0.9.2

## 0.2.1

### Patch Changes

- Updated dependencies [cdd061a]
- Updated dependencies [1227128]
  - @substrat-run/contracts@0.199.0
  - @substrat-run/vertical-host@0.199.0
  - @substrat-run/demo-todo@1.0.12
  - @substrat-run/adapter-sqlite@0.199.0
  - @substrat-run/dev-issuer@0.9.1
  - @substrat-run/kernel@0.199.0

## 0.2.0

### Minor Changes

- f57381d: Todo may call Notes as the person signed in to it, with the notepad's keys only (`delegations` in the manifest, the `peer` channel). Item notes have keys of their own, `item-note:read` and `item-note:write`, which `writer` holds and the delegation does not, because their operations rely on the door's vouch from Todo (#3161). Todo is declared a peer here, allowlisted for nothing and seated with `todo-peer:admit`, so the operator's peer switch for Todo stops its calls made for people too.

### Patch Changes

- Updated dependencies [e52951e]
- Updated dependencies [a7d4147]
- Updated dependencies [f57381d]
- Updated dependencies [f57381d]
- Updated dependencies [f57381d]
- Updated dependencies [db1b0df]
- Updated dependencies [f57381d]
- Updated dependencies [344f406]
- Updated dependencies [70d8dc5]
- Updated dependencies [f57381d]
- Updated dependencies [e52951e]
- Updated dependencies [f57381d]
  - @substrat-run/contracts@0.198.0
  - @substrat-run/kernel@0.198.0
  - @substrat-run/adapter-sqlite@0.198.0
  - @substrat-run/dev-issuer@0.9.0
  - @substrat-run/vertical-host@0.198.0
  - @substrat-run/demo-todo@1.0.11

## 0.1.2

### Patch Changes

- Updated dependencies [7b93798]
- Updated dependencies [2fd76c2]
  - @substrat-run/kernel@0.197.0
  - @substrat-run/adapter-sqlite@0.197.0
  - @substrat-run/vertical-host@0.197.0
  - @substrat-run/contracts@0.197.0
  - @substrat-run/demo-todo@1.0.10
  - @substrat-run/dev-issuer@0.8.1

## 0.1.1

### Patch Changes

- Updated dependencies [12933eb]
- Updated dependencies [8757b2c]
- Updated dependencies [77ce7f0]
  - @substrat-run/contracts@0.196.0
  - @substrat-run/dev-issuer@0.8.0
  - @substrat-run/demo-todo@1.0.9
  - @substrat-run/adapter-sqlite@0.196.0
  - @substrat-run/kernel@0.196.0
  - @substrat-run/vertical-host@0.196.0
