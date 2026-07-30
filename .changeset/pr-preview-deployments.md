---
'@substrat-run/control-plane-api': minor
'@substrat-run/cli': minor
'@substrat-run/dashboard': minor
---

Per-PR preview instances for private verticals (preview-and-snapshots.md §2/§9, D-43).

Open a PR → a preview instance running the PR's pushed code against a **fork of the
tenant's prod data**, on its own `<label>--pr-N.<base>` URL; close the PR → it's reaped
(with a per-preview `expiresAt` as the GC backstop). Also drivable by hand from the CLI.

- **control-plane-api**: `orchestratedPreview` + three builder-reachable routes —
  `POST/GET/DELETE /verticals/:slug/previews`. Create forks the source prod scope (the
  §9 cross-version path: export from where prod data lives → import into the PR version's
  deployment), binds the pushed version to the fork, and mints a non-canonical preview
  hostname; delete delegates to the existing fork-reap. Gated `global`-jurisdiction only
  (K-32) with the canonical audited export path. Private verticals only — a private
  push self-admits (D-36), so no admission relaxation is needed.
- **cli**: `substrat preview create|delete|ls`. `create` pushes the working tree, then
  forks + binds; re-running the same `--tag` rebinds onto the same fork so a PR's
  successive pushes roll migrations forward on one copy (`--refresh` re-forks). Uses the
  existing tenant-scoped push token — no new credential.
- **dashboard**: the generated `substrat-deploy.yml` gains `pull_request` jobs —
  create/update the preview on open/synchronize (and comment the URL back), reap it on
  close — alongside the existing push-to-branch prod deploy.
