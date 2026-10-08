# @substrat-run/social-relay

## 0.1.24

### Patch Changes

- Updated dependencies [35dc72e]
- Updated dependencies [32df62b]
- Updated dependencies [6154fd9]
- Updated dependencies [6d49012]
- Updated dependencies [55e6241]
- Updated dependencies [13a2067]
- Updated dependencies [7b15101]
- Updated dependencies [72f8e92]
- Updated dependencies [d42bb2b]
- Updated dependencies [e5bd928]
- Updated dependencies [b180d3e]
- Updated dependencies [07388df]
- Updated dependencies [ae80b0d]
- Updated dependencies [a1f40e5]
- Updated dependencies [0e3d406]
- Updated dependencies [5405401]
- Updated dependencies [655141a]
- Updated dependencies [f1290ea]
- Updated dependencies [ced5130]
  - @substrat-run/kernel@0.140.0

## 0.1.23

### Patch Changes

- Updated dependencies [d62f6fb]
- Updated dependencies [98492af]
- Updated dependencies [2a505df]
- Updated dependencies [ec25a00]
- Updated dependencies [4a14c92]
- Updated dependencies [d55b4cd]
- Updated dependencies [48bf765]
  - @substrat-run/kernel@0.139.0

## 0.1.22

### Patch Changes

- Updated dependencies [d5739ca]
- Updated dependencies [50ce5e0]
- Updated dependencies [59972cb]
- Updated dependencies [6476e71]
- Updated dependencies [d08b9b1]
- Updated dependencies [f33b1c3]
- Updated dependencies [921dfa3]
  - @substrat-run/kernel@0.138.0

## 0.1.21

### Patch Changes

- Updated dependencies [7559e1a]
- Updated dependencies [21055d5]
- Updated dependencies [b641075]
- Updated dependencies [7adf5c7]
- Updated dependencies [1c411fc]
  - @substrat-run/kernel@0.137.0

## 0.1.20

### Patch Changes

- Updated dependencies [1af2d47]
- Updated dependencies [4fdad69]
- Updated dependencies [4964eb8]
- Updated dependencies [30c2cda]
- Updated dependencies [b9b3b82]
- Updated dependencies [3ed9e9d]
- Updated dependencies [cdf32ab]
- Updated dependencies [7418e7e]
- Updated dependencies [18069f9]
  - @substrat-run/kernel@0.136.0

## 0.1.19

### Patch Changes

- Updated dependencies [8267b83]
- Updated dependencies [1dca2da]
- Updated dependencies [3328549]
- Updated dependencies [8c64633]
- Updated dependencies [5d41454]
  - @substrat-run/kernel@0.135.0

## 0.1.18

### Patch Changes

- Updated dependencies [176fe60]
- Updated dependencies [4347933]
- Updated dependencies [1addd27]
- Updated dependencies [560eec4]
  - @substrat-run/kernel@0.134.0

## 0.1.17

### Patch Changes

- Updated dependencies [8a32578]
- Updated dependencies [c74c091]
- Updated dependencies [a128e65]
  - @substrat-run/kernel@0.133.0

## 0.1.16

### Patch Changes

- @substrat-run/kernel@0.132.0

## 0.1.15

### Patch Changes

- Updated dependencies [012b2c8]
- Updated dependencies [56091f8]
- Updated dependencies [e5c21fc]
  - @substrat-run/kernel@0.131.0

## 0.1.14

### Patch Changes

- Updated dependencies [65a0690]
- Updated dependencies [b53ecff]
- Updated dependencies [8236531]
  - @substrat-run/kernel@0.130.0

## 0.1.13

### Patch Changes

- Updated dependencies [b213bfc]
  - @substrat-run/kernel@0.129.0

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
