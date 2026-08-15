---
'@substrat-run/builder': minor
'@substrat-run/builder-web': minor
'@substrat-run/control-plane': minor
'@substrat-run/console': minor
---

feat: the `builder` entitlement gates the studio + the console Members view

Granting someone the builder studio no longer means granting them the control
plane — and access follows the team, not an email list. The studio's gate is
now: platform staff OR membership in a tenant holding the `builder`
entitlement (granted per tenant in the console like any SKU; expiry applied at
read, so a lapsed trial closes the studio). The CP's identity-tenants lookup
returns each membership flagged with the entitlement; the studio resolves
teams once per request, dispatches only into usable ones, and serves a proper
HTML denied page for browsers (JSON for API callers) with a federated
switch-account link. The studio-wide `/api/usage` rollup becomes staff-only
(it is cross-team until metering is per-team) and the SPA hides the Usage tab
for non-staff via a new `staff` flag on `/api/me`.

The console's "Members" nav item graduates from Planned to a real view: the
staff roster with grant/revoke/re-grant over new staff-gated `/api/members*`
routes on the CP worker. Grants record the acting staff member (`added_by`,
CP migration 0003); a re-granted staff member keeps their actor so admin-log
history stays attributed; revoking the last active staff member is refused.
Design record: builder-studio.md §15.
