---
'@substrat-run/cli': patch
---

A promote refused until someone acknowledges it (a permission, migration or export-break change, or a stale review) now ends by saying it waits on a person, and where to answer it: the Substrat approvals pane, or `substrat promote <slug> --review-only`. The `--ack-*` line and its `--review` token are printed as before.
