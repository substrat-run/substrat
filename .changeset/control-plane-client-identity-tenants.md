---
'@substrat-run/control-plane-api': minor
---

`ControlPlaneClient.identityTenants(externalId)` — the builder studio's membership read (`POST /internal/builder/identity-tenants`): the tenants a login builds for, each flagged with whether it holds the `builder` entitlement. Additive: a new method and two new exports (`identityTenantsResponse`, the schema the answer is parsed with, and its `IdentityTenant` type); nothing existing changes.

The answer is parsed rather than cast, and a failure is raised as `ControlPlaneError` like every other client call — a refusal carries the plane's problem-document `detail`, and a body of the wrong shape (a renamed `entitled`, an `{ error }` answered with a 200) throws `identity-tenants returned an unexpected shape: …` naming the field that was wrong, never the body. The studio read this as `${status} ${text}` by hand and never saw the document; it now uses the client.
