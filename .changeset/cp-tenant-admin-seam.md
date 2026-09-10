---
'@substrat-run/control-plane-api': minor
'@substrat-run/dashboard': patch
---

The shared control plane grows the runtime membership seam (#1343, step 2).
Service-only routes for assigning and revoking an already-defined role, and for
creating and listing a tenant's orgs, with the matching
`TenantNarrowedControlPlane` methods.

The line these sit on the far side of matters more than the routes. `defineRole`
says what a role MEANS — a permission change, and the permission diff is a human
checkpoint (D-22/D-29) — so it still gets no route, and `roleDefinition`'s own
contract already says role writes are deliberately absent from this surface.
ASSIGNING an already-defined role is a different act: per-principal, runtime, the
same shape control-plane.md §4.5 already treats as a console concern rather than
a checkpoint artifact, and `unassignRole`'s contract anticipates exactly this
caller ("the dashboard's manage-members check").

Service/staff only, absent from `BUILDER_ROUTES`: a builder must no more assign
itself a role than write the directory that authenticates builders. The whole
node comes from the PATH — assignments are TENANT-LEVEL, which is what a team
membership is, and a body naming a scope is refused rather than stripped.
Pinning only the tenant would pin nothing: a node carrying a scope is written to
that scope's Durable Object directly, with no tenant cross-check below it. A
scope-level surface, if ever needed, wants its own route under
`/tenants/:tenantId/scopes/:scopeId/role-assignments`, deriving the node from the
path after the K-3 cross-check every other scope-addressed route performs.

Nothing switches over yet — the dashboard still reads and writes its own
directory. This is the seam that has to exist before it can stop.
