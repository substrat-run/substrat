---
'@substrat-run/dashboard': minor
---

Per-PR previews get a platform half: the GitHub App now listens to `pull_request`
webhooks (`POST /api/github/webhook`, HMAC-gated). The one-click CI setup records a
durable repo → tenant-app link in a per-repo `GithubRepoLinkDO`; on a PR push the DO
watches the control plane until CI's `substrat preview create` lands, then posts the
sticky preview-URL comment itself (same `<!-- substrat-preview -->` marker as the CI
step, so the two writers upsert one comment); on PR close it reaps the preview fork
and flips the comment — even when the repo's workflow is stale or CI is red. Builds
stay in the repo's own Actions: the platform only ever comments and reaps. Needs the
App's webhook configured (`GITHUB_APP_WEBHOOK_SECRET`) and the `pull_requests: write`
permission; repos wired before this link existed pick it up on their next setup re-run.
