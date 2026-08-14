---
"@substrat-run/builder-workspace": minor
"@substrat-run/builder": minor
---

Mode C (#626): `ContainerWorkspace` — the second implementation of the §3
Workspace seam, over a Cloudflare Sandbox container, with the same path guard
and confinement the local mode enforces (structural `SandboxLike`, no
worker-only deps in the package). `builder.Dockerfile` bakes the monorepo warm
(pnpm install + full build + a native better-sqlite3 check that fails the
image, not a session). The hosted studio executes: the BuilderAgent DO runs
the same turn loop as the local server (ensureVerticalRepo per turn against
ephemeral disk, generator over the project-rooted workspace, standalone gates,
commit-per-turn, NDJSON with heartbeat) in a per-project sandbox, with skills
read from the image and providers resolved from worker secrets (anthropic,
qwen, compat; ollama refused hosted with the reason). Hosted project code is
scratch until #627 (R2 bundles); /api/dev preview and the hosted picker
catalog are named follow-ups.
