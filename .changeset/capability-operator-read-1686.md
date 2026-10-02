---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/vertical-host': minor
---

An operator can now read the capabilities a scope has minted. `HostAdmin.listCapabilities` returns the directory `ctx.capabilities.list` reads from inside a module, newest first: for each link share or claim link, what it may do (its entity, keys and operation allowlist, or the principal a claim link yields), who minted and revoked it, when it expires and how often it has been used. Live capabilities are listed unless you ask for `includeRevoked`, and you can narrow to one entity. A record never carries a secret or a hash. The control plane serves it at `GET /tenants/:t/scopes/:s/capabilities`, to staff only, and reads a hosted scope's directory through the vertical's own `/internal/capabilities`. `ControlPlaneStaffClient.listCapabilities` calls it, and the console's scope page has a Capabilities card. `capabilityStatus` in contracts names a record's standing (live, used up, expired, revoked).
