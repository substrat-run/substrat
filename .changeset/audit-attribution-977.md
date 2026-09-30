---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
---

The admin log now records who a service acted for, and the dashboard's tenant credential reaches only the routes the dashboard uses.

- An admin-log entry carries `onBehalfOf`: the principal and tenant of the person the actor acted for, plus the impersonation stamp when a staff member was acting as them. `actor` is unchanged and still names the credential that executed. A row written with nobody behind it has `onBehalfOf: null`, which is also how every earlier row reads.
- `ScopeHost.attributed(onBehalfOf)` returns a view of the host whose admin rows carry that person. This covers the `admin` surface and host-level writes such as `provisionScope`. Each view is independent, so concurrent requests never see each other's person. Both adapters implement it, and the contract suite holds them to it.
- A tenant token can name the person it was minted for. `POST /tenant-tokens` accepts an optional `principal` and `impersonation`, and the control plane writes every admin row for that token through an attributed view. The person is attribution, not authority: what the token may reach is decided by its tenant alone.
- The tenant credential's allowlist names each route under `/tenants/<own>/…` instead of one catch-all per method. It no longer reaches the tenant's own status, entitlement revocation, redrain, adopt-serving, unsuspend or unarchive.
- A tenant credential may grant its own tenant only an entitlement that a vertical it can see declares, or that vertical's bare slug. It cannot set plan fields.
- `rebind-vertical` answers 404 when a confined caller names a target vertical it cannot read.
