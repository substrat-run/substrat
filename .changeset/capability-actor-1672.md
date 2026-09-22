---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/vertical-host': minor
'@substrat-run/dashboard-web': patch
'@substrat-run/console': patch
---

A vertical can now share by link, and the permission checker enforces the link. A capability is authority carried by a secret rather than held by a principal: "anyone with this link may read this folder until Friday". An operation mints one with `ctx.capabilities.mint({ entity, permissions, operations?, expiresAt?, maxUses? })` and gets the secret back once. Whoever exchanges that secret acts as `{ capability: <id> }`, which is a new member of the event and denial actor union.

- **Exactly one subtree, exactly its keys.** A capability reaches its entity and everything beneath it through declared parent edges, and only the keys it carries. It holds no node-level authority, so an operation whose only check is a node-level one refuses it. An optional `operations` list narrows it further, and is enforced before the handler runs.
- **Never more than its minter holds, on every use.** Each key is checked on the entity at mint time with the operation's own check, the same way `ctx.grant` checks. The checker also re-checks the minter every time the capability acts, so a link stops granting the moment its minter loses access. Only a principal may mint. A capability, a connection, a schedule or a consumer cannot.
- **Directory-backed.** The capability is a row in the scope's own spine (`_substrat_capabilities`), read on every check. A revoke takes effect on the next call, including through sessions already handed out. `ctx.capabilities.revoke` is open to anyone who could have minted the capability, and `ctx.capabilities.list` reads them back.
- **A use is an exchange, not an invocation.** `ScopeHost.exchangeCapability` trades the secret for a session token and counts one use. `maxUses` bounds how many browsers may hold a capability, not how many reads they make. A single-use capability exchanged twice at once admits one. `getCapabilityScope(sessionToken, …)` is the door, and it re-resolves the session on every invoke.
- **On the spine.** Events a capability causes carry `{ capability }` as their actor, with K-34 authorization naming the root it was granted on. Its refusals land in the K-35 denial log. Every exchange is a `capability.exercised` spine event. A MODULE's mint and revoke (`ctx.capabilities`) are spine events too (`capability.minted`, `capability.revoked`), but the platform's `HostAdmin.mintCapability` and `HostAdmin.revokeCapability` write the admin log only. A consumer must not wait for a `capability.minted` or `capability.revoked` that a platform mint or revoke never produces.
- **Only the secret's hash is stored.** The kernel keeps its SHA-256, and an idempotent replay of a mint returns `[capability secret withheld]`. There is also a tripwire for accidents: while the minting invocation runs, `ctx.emit`, `ctx.requestPlatform` and `ctx.sql` refuse any record that carries the secret verbatim, anywhere in it (keys, entity ids, request kinds and byte parameters included). It catches a module persisting its own secret by mistake. It is not a boundary against a module that means to leak one, which could encode it first.
- **`@substrat-run/vertical-host`: `mountCapabilityExchange`.** The link carries the secret in its fragment (`#share=…`), which never reaches a server. The page posts it once to `/api/capability/exchange`, and the response sets the session as an HttpOnly `sb_capability` cookie, with `no-store` and `Referrer-Policy: no-referrer`. `capabilityStubOf(c, host, node)` then gives a request's stub.
- **`become` capabilities, platform-minted.** `HostAdmin.mintCapability` mints a capability whose exchange yields a principal, the shape an owner claim link or an invite has. It requires an expiry and a use limit, and is audited. `HostAdmin.revokeCapability` revokes any capability. An exchange can name the one mode it takes, and a secret of the other mode is refused without spending its use.
- The dashboard's history and the console's denial log name a capability actor as the link it came through.
