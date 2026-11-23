# @substrat-run/demo-notes

## 0.2.10

### Patch Changes

- Updated dependencies [188d7a2]
  - @substrat-run/contracts@0.208.0
  - @substrat-run/kernel@0.208.0
  - @substrat-run/adapter-sqlite@0.208.0
  - @substrat-run/demo-todo@1.0.21
  - @substrat-run/dev-issuer@0.9.10
  - @substrat-run/vertical-host@0.208.0

## 0.2.9

### Patch Changes

- Updated dependencies [ef699c1]
- Updated dependencies [ef699c1]
- Updated dependencies [98e8423]
  - @substrat-run/contracts@0.207.0
  - @substrat-run/kernel@0.207.0
  - @substrat-run/vertical-host@0.207.0
  - @substrat-run/demo-todo@1.0.20
  - @substrat-run/adapter-sqlite@0.207.0
  - @substrat-run/dev-issuer@0.9.9

## 0.2.8

### Patch Changes

- Updated dependencies [ec6c0ee]
- Updated dependencies [5244ed9]
- Updated dependencies [ff7fc65]
- Updated dependencies [03d8f69]
- Updated dependencies [866be58]
- Updated dependencies [a23e0a1]
- Updated dependencies [a6146fc]
  - @substrat-run/kernel@0.206.0
  - @substrat-run/contracts@0.206.0
  - @substrat-run/adapter-sqlite@0.206.0
  - @substrat-run/vertical-host@0.206.0
  - @substrat-run/demo-todo@1.0.19
  - @substrat-run/dev-issuer@0.9.8

## 0.2.7

### Patch Changes

- Updated dependencies [dccd345]
- Updated dependencies [d7a79e5]
- Updated dependencies [af44e9e]
- Updated dependencies [3b8ba29]
- Updated dependencies [b83cf97]
- Updated dependencies [95a6184]
  - @substrat-run/contracts@0.205.0
  - @substrat-run/kernel@0.205.0
  - @substrat-run/adapter-sqlite@0.205.0
  - @substrat-run/vertical-host@0.205.0
  - @substrat-run/demo-todo@1.0.18
  - @substrat-run/dev-issuer@0.9.7

## 0.2.6

### Patch Changes

- Updated dependencies [dd3c1ad]
- Updated dependencies [0e9e717]
  - @substrat-run/contracts@0.204.0
  - @substrat-run/demo-todo@1.0.17
  - @substrat-run/adapter-sqlite@0.204.0
  - @substrat-run/dev-issuer@0.9.6
  - @substrat-run/kernel@0.204.0
  - @substrat-run/vertical-host@0.204.0

## 0.2.5

### Patch Changes

- Updated dependencies [f1f01b0]
  - @substrat-run/contracts@0.203.0
  - @substrat-run/demo-todo@1.0.16
  - @substrat-run/adapter-sqlite@0.203.0
  - @substrat-run/dev-issuer@0.9.5
  - @substrat-run/kernel@0.203.0
  - @substrat-run/vertical-host@0.203.0

## 0.2.4

### Patch Changes

- Updated dependencies [7892b6b]
- Updated dependencies [ef4631e]
- Updated dependencies [d8530ae]
- Updated dependencies [44ce6fd]
- Updated dependencies [54fbd42]
- Updated dependencies [b59a4af]
- Updated dependencies [f642a08]
  - @substrat-run/contracts@0.202.0
  - @substrat-run/vertical-host@0.202.0
  - @substrat-run/kernel@0.202.0
  - @substrat-run/adapter-sqlite@0.202.0
  - @substrat-run/demo-todo@1.0.15
  - @substrat-run/dev-issuer@0.9.4

## 0.2.3

### Patch Changes

- Updated dependencies [1f564fe]
- Updated dependencies [e210618]
  - @substrat-run/contracts@0.201.0
  - @substrat-run/demo-todo@1.0.14
  - @substrat-run/adapter-sqlite@0.201.0
  - @substrat-run/dev-issuer@0.9.3
  - @substrat-run/kernel@0.201.0
  - @substrat-run/vertical-host@0.201.0

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
