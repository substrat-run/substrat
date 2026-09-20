# @substrat-run/social-relay

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
