---
'@substrat-run/vertical-host': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/control-plane-client': patch
'@substrat-run/cli': patch
'create-substrat': patch
'@substrat-run/dashboard': patch
'@substrat-run/console': patch
---

An app that keeps no owner of record (no `resolveOwner` hook) now receives what each new version declares on its existing installs. Until now its reconcile answered 501, so an install provisioned before a version that adds a peer, a schedule or a connection grant never received it, and a peer's calls stayed refused.

The platform's reconcile and `substrat scope provision` now ask for the ownerless reconcile (`ownerless: 'seat'`). The vertical seats only the tuples its running version declares: schedule grants, peer permissions, and the connection grants the platform delivers. It also re-applies the switches the platform recorded off. It changes nothing else. It writes no owner, leaves roles, entitlements, identity links and sealing keys as they are, and reconciles no entity-grant shapes. It answers `owner: null`. `substrat scope provision` then says the owner was not re-sourced, and that a locked-out owner is not repaired by it. An app that keeps an owner of record but has none for the install still answers 409, and is retried until the record exists. An entitlements delivery does not ask for the ownerless reconcile and is refused as before. `adapter-cloudflare` adds `seatScopeLocal`, which only seats a scope already provisioned for that tenant.

The console's "Re-run provisioning" says the same when no owner was re-sourced. The "What this app calls" panel now names the second reason a target can grant an app nothing: its install predates the version that declares the app as a peer.
