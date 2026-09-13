---
'@substrat-run/vertical-auth': minor
---

`mountInviteRoutes(app, deps)` — the member-invite routes a vertical mounts (list, create, revoke, accept), written once instead of copied per worker. A vertical supplies its node resolver, its admin gate, its roles, its identity directory, the host's `assignScopeRole` and its auth provider; the token minting, the hash-only storage, the grant-before-record order and the status codes are the package's. `hono` becomes a peer dependency, as it is for `@substrat-run/dev-issuer`.
