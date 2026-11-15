---
'@substrat-run/vertical-host': minor
---

The peer door takes a call made for a person (#3161): `/internal/vertical-invoke` accepts `onBehalf`, answers `PEER_CLIENT_OPERATION` itself, and runs an admitted call as the person with the token's scope as the ceiling (`PlatformSurfaceDeps.peerClient`, `delegatedPeer`). `workerDoor` gains `people` (a dependent signs people in through its master), `refreshTokens`, and `peerAs` (a master calls a plugin as the signed-in person); `peerClient().invoke` carries `onBehalf`.
