# @substrat-run/social-relay

## 0.1.12

### Patch Changes

- Updated dependencies [260fb5a]
- Updated dependencies [4a53af7]
- Updated dependencies [4ba2a52]
- Updated dependencies [f79e8ba]
- Updated dependencies [ba75c81]
  - @substrat-run/kernel@0.128.0

## 0.1.11

### Patch Changes

- Updated dependencies [2f1e5f5]
- Updated dependencies [b6248b0]
  - @substrat-run/kernel@0.127.0

## 0.1.10

### Patch Changes

- Updated dependencies [6d57761]
- Updated dependencies [c78e713]
  - @substrat-run/kernel@0.126.0

## 0.1.9

### Patch Changes

- Updated dependencies [e8d4860]
- Updated dependencies [9ebacee]
  - @substrat-run/kernel@0.125.0

## 0.1.8

### Patch Changes

- Updated dependencies [90d0f02]
- Updated dependencies [02942e0]
- Updated dependencies [931b8d6]
- Updated dependencies [558f103]
  - @substrat-run/kernel@0.124.0

## 0.1.7

### Patch Changes

- Updated dependencies [6b3cb45]
- Updated dependencies [ae19d01]
- Updated dependencies [30b09c6]
- Updated dependencies [d423d10]
- Updated dependencies [bd8f408]
  - @substrat-run/kernel@0.123.0

## 0.1.6

### Patch Changes

- Updated dependencies [0803833]
- Updated dependencies [1e326dd]
- Updated dependencies [3a3338d]
  - @substrat-run/kernel@0.122.0

## 0.1.5

### Patch Changes

- Updated dependencies [a235648]
- Updated dependencies [6fc9950]
- Updated dependencies [48fea30]
- Updated dependencies [a6f4db1]
- Updated dependencies [45b927e]
  - @substrat-run/kernel@0.121.0

## 0.1.4

### Patch Changes

- Updated dependencies [1de077d]
  - @substrat-run/kernel@0.120.0

## 0.1.3

### Patch Changes

- Updated dependencies [bc6a6bb]
- Updated dependencies [84b5fe2]
- Updated dependencies [929ec09]
- Updated dependencies [a9cfc4a]
- Updated dependencies [2c65b67]
- Updated dependencies [8009cd1]
- Updated dependencies [b080e0f]
  - @substrat-run/kernel@0.119.0

## 0.1.2

### Patch Changes

- Updated dependencies [56a931b]
  - @substrat-run/kernel@0.118.0

## 0.1.1

### Patch Changes

- Updated dependencies [6504a99]
- Updated dependencies [aabc227]
- Updated dependencies [fb37a3e]
- Updated dependencies [44299a1]
- Updated dependencies [4ef164c]
- Updated dependencies [269fa7a]
- Updated dependencies [105a4c3]
- Updated dependencies [a8c2c64]
- Updated dependencies [02c181a]
- Updated dependencies [2fa5147]
- Updated dependencies [1f223f5]
  - @substrat-run/kernel@0.117.0

## 0.1.0

### Minor Changes

- 0ab0d64: Add the platform's social sign-in relay: one OAuth client per upstream (Google, GitHub,
  Apple), held in a worker with no tenant-controllable config, behind one OIDC issuer per
  provider. An installed Auth Server can federate to it as an ordinary generic upstream and
  offer social sign-in without its team ever creating, holding or rotating a provider
  credential — what the install holds is its own client at the relay, which is worth nothing
  anywhere else. The relay keeps no users, no sessions and no cookie, renders no UI beyond an
  error it cannot safely redirect, and registers clients only for the platform.

### Patch Changes

- Updated dependencies [e22db55]
- Updated dependencies [a67c59b]
- Updated dependencies [45d2f15]
- Updated dependencies [e99332e]
- Updated dependencies [1c55458]
- Updated dependencies [0b993ff]
  - @substrat-run/kernel@0.116.0
