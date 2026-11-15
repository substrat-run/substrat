---
'@substrat-run/vertical-host': minor
---

The peer door takes a call made for a person (#3161): `/internal/vertical-invoke` accepts `onBehalf`, answers `PEER_CLIENT_OPERATION` itself, and runs an admitted call as the person with the token's scope as the ceiling, while the calling vertical passes the scope's peer admission (declared, switched on) (`PlatformSurfaceDeps.peerClient`, `delegatedPeer`). `workerDoor` gains `people` (a dependent signs people in through its master, and caps a call made for a person to its own declared `delegations`), `refreshTokens`, and `peerAs` (a master calls a plugin as the signed-in person); `peerClient().invoke` carries `onBehalf`.
