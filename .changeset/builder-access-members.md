---
'@substrat-run/builder': minor
'@substrat-run/builder-web': minor
'@substrat-run/control-plane': minor
'@substrat-run/console': minor
---

feat: builder-studio invites + the console Members view

Granting someone the builder studio no longer means granting them the control
plane. A new `builder_access` table (CP migration 0003, same tombstone
semantics as the staff roster) admits an email to builder.substrat.net and
nothing else; the studio's gate is now staff OR invite, still AND-ed with team
membership. The studio-wide `/api/usage` rollup becomes staff-only (it is
cross-team until metering is per-team) and the SPA hides the Usage tab for
invited builders via a new `staff` flag on `/api/me`.

The console's "Members" nav item graduates from Planned to a real view: the
staff roster and the builder invite list, with grant/revoke/re-grant over new
staff-gated `/api/members*` routes on the CP worker. Every grant records the
acting staff member (`added_by`, also added to `staff_actor`); a re-granted
staff member keeps their actor so admin-log history stays attributed; revoking
the last active staff member is refused. The builder's denied response is now
a proper HTML page for browsers (JSON for API callers) with a federated
switch-account link.
