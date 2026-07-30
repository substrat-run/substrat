---
'@substrat-run/dashboard': minor
'@substrat-run/dashboard-web': minor
---

Multi-scope M4: a scope switcher on the app Data tab.

The Data tab browsed only the single app scope, so a multi-scope vertical (Manyfold: one site
per scope) showed nothing of its other scopes. It now lists the app's scopes and lets you pick
which one's database to browse. New `GET /api/apps/:scopeId/scopes` returns the tenant's scopes
for the app's vertical (tenant-narrowed via `TenantNarrowedControlPlane.listScopes` in connected
mode, `host.admin.listScopes` embedded), and `DataBrowser` renders a scope `<select>` above the
table list — shown only when an app spans more than one scope, so single-scope apps are
unchanged. The existing table/row/query reads are keyed off the chosen scope; permissions and
audit are untouched (they were already per-scope). Listing is a control-plane directory read —
no vertical cooperation — while each scope's data still goes through the existing per-scope
introspection.
