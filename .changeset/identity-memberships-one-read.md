---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/dashboard': patch
---

`HostAdmin.listIdentityMemberships(actor, provider, externalId)`: which tenants a central-pool login is in, with each tenant row, the login's principal in it and the scope the link was made in — one directory read and one access-log row, where composing it from `listIdentityTenants` + `getTenant`/`resolveIdentity` per tenant cost 2N+ reads. Central pools only, as `listIdentityTenants` is.

`GET /verticals` takes `ownerTenant` and `visibleTo` for a staff/service caller that wants one tenant's slice rather than the registry. Both only narrow, and both are ignored for a builder session, whose view is fixed by its auth.

Dashboard: every `/api/*` request used to resolve its caller through a chain of directory round trips that grew with the number of teams the login is in — about three seconds for a login in ten. It is now one read, reused for 30 seconds; the idempotent self-heals (pool registration, role reconcile, catalog seed) run once per isolate instead of once per request; the deployment and app routes ask their independent reads together and no longer hydrate every version of every vertical to check that one slug is yours; and metrics reads are remembered for a minute per data centre (logs never are).
