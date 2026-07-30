---
'@substrat-run/control-plane-api': minor
'@substrat-run/dashboard': patch
---

Dashboard permissions view + version-to-version admission diff (#336, D-39).

The permission registry a vertical declares has shipped inside the deploy manifest
since #299 (`manifest.registry`: keys+descriptions, role templates, entity-grant
shapes), but nothing consumed it — a tenant installing or updating an app could not
see what permissions and roles it declares. This adds the tenant-facing view #299 left
as a follow-up, with no new backend plumbing beyond a read path.

- **control-plane-api**: a new owner-narrowed `GET /verticals/:slug/versions/:id/registry`
  reads one version's declared permission surface out of its retained manifest (null for a
  pre-#286 version, or one that declares no surface). Owner-narrowed exactly like the
  versions list — a builder reading a vertical it does not own gets a 404. Read-only: the
  promotion permission-diff checkpoint stays the human gate.

- **dashboard**: `GET /api/apps/:scopeId/permissions` resolves the registry of the version
  the app actually runs (its pinned version, the router's truth) plus the prod-head update
  target's, through the tenant-narrowed control plane (connected) or the retained manifest
  (embedded). A new **Permissions** tab renders the declared surface — keys grouped by
  declaring engine (key → description → the roles that hold it), role templates, and
  entity-grant **shapes** (the per-principal grants themselves stay a runtime concern) —
  and, when an update is available, a version-to-version diff flagging new/removed/
  re-described keys and **widened roles**. Absent-registry (D-28 optional), no-roles, and
  no-running-version cases render explicitly rather than crashing.

This is the tenant-facing rendering of the permission-diff human checkpoint: the tab
displays, but approving a widened role stays a human decision made when updating on the
Deployments tab.
