---
'@substrat-run/vertical-host': minor
'create-substrat': minor
---

A generated app can sign people in once it is deployed. `workerDoor` in `@substrat-run/vertical-host/worker-door` owns the login round-trip, `/api/me`, the owner claim and the provisioning hooks, and hands every operation the caller's verified address. The template's worker uses it, and its `ConfigDO` store is replaced by the `IdentityDO` store `AUTH`. Member invites are not in it yet: a worker that wants them mounts `mountInviteRoutes` with its own admin gate.
