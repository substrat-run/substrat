---
'@substrat-run/control-plane-api': patch
---

Deploy-failure reporting is honest end-to-end (#307). A `substrat push` of a vertical that
throws at module import time (e.g. an "api catalog drift" self-check) builds, dry-runs clean,
uploads, and is then refused by Workers-for-Platforms with CF 10021 — and the failure that
came back was undiagnosable in two ways.

- **The upstream error was truncated mid-token.** The WfP error body was clipped with a bare
  `body.slice(0, 400)`, so it ended `…eka/set-budg` — no marker, no closing brace, the rest of
  the list invisible, and no way to tell a real operation name from a severed string. A new
  `clip(body, max = 2000)` helper carries the body through whole up to a generous cap and, when
  it must clip, appends an explicit `… [truncated, N chars omitted]` instead of cutting silently.

- **A bad bundle read as a platform outage.** Every upload failure collapsed to a `502`, even a
  Cloudflare `4xx` that is the builder's own script being refused — sending the reader hunting
  for a platform problem first. The uploader now throws `DeployUploadError` carrying the upstream
  status (part of the deploy seam, `upstreamStatusOf`), and the deploy endpoint answers a runtime
  `4xx` as `422 deploy rejected` (well-formed HTTP, semantically refused — the builder's fault),
  keeping `5xx`/unknown as `502 deploy upload failed`.

Also clarified: a version **label is consumed only on a successful upload**. The endpoint records
the pending version *after* the upload returns, so a push that fails at the upload step never
registers the label and the same `--version` is reusable on retry (documented in
self-serve-deploy.md §5). Booting the isolate at build time to catch import-time throws locally
(the issue's third ask) is intentionally not done here — it would add a Workers runtime dependency
to the CLI; the honest remote error is the mitigation.
