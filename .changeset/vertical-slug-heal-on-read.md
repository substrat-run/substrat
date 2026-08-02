---
'@substrat-run/dashboard': patch
---

The dashboard's app row heals its vertical lineage on read (#389). A staff
`rebind-vertical` moves a scope onto a different lineage (builtin `manyfold` →
tenant-owned `substrat-9yjbbn/manyfold`) and the directory's scope record is the
source of truth — but the row's `vertical_slug` still named the old lineage, which
misrouted the per-app Update path (prod channels resolve by slug) and the Apps
view's version display. The `GET /api/apps` reconcile (the same read that heals a
stranded `provisioning` row, #424 case 4) now also compares the directory's
`vertical` against the row's slug and, when they differ, updates the row via a new
`dashboard/reconcile-app-vertical` operation — same authority as provisioning,
idempotent, with the move recorded on the Activity trail (`rebound old → new`).
Best-effort like the mark-active heal: a viewer session lacks the permission and
the row heals on an owner's next visit. No migration — the column already exists.
