---
'@substrat-run/cli': patch
---

`substrat versions <slug>` now agrees with `hostnames <slug>` on what a bare product
name means (#399). A staff push pinned to a tenant registers the vertical as
`<tenantSlug>/<name>`, so the exact-slug versions read came back empty and the CLI
printed a lineage-fork warning against a perfectly healthy install. `versions` now
resolves a bare name to its single workspace-prefixed registration (with a note naming
the identity it read), lists the candidates when several prefixed registrations exist
rather than guessing, and — when the zero-versions state IS a real fork — names the
install-side slug from the hostname rows so the rename is one command away.
