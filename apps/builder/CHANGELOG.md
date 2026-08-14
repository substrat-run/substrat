# @substrat-run/builder

## 0.2.0

### Minor Changes

- 49d9a35: Cloudflare Workers AI as a builder model provider (OpenAI-compatible mode), local and hosted. The endpoint is account-scoped, so `CLOUDFLARE_AI_BASE_URL` carries the account id; the token is a dedicated `CLOUDFLARE_AI_API_TOKEN` with the Workers AI permission only — never wrangler's ambient deploy token. Model ids keep their catalog prefix: `@cf/…` runs on Cloudflare's network, bare `vendor/model` slugs are partner-served under unified billing (surfaced honestly in the model picker per D-53). Hosted secrets: `BUILDER_CLOUDFLARE_AI_BASE_URL` / `BUILDER_CLOUDFLARE_AI_API_TOKEN` in the secrets manifest.

### Patch Changes

- d77d0ac: R2 ops corrections: app-level ULID-keyed bundle history replaces the
  nonexistent R2 object versioning (restore reads newest, legacy single-key
  still readable, prune keeps 10); provision script prefers a narrow
  BUILDER_CF_API_TOKEN and verifies it against R2 instead of guessing.
- 45c8ee8: Provider errors name their real failure class (quota exhausted ≠ invalid key ≠
  rate limit ≠ wrong region), keep the provider's own message, and say what to do
  next — shared worker-safe explainer for the hosted DO and the local CLI.
- 9ddd361: Token economy for builder turns: Anthropic prompt caching (stable system+skills prefix and last history message get ephemeral cacheControl breakpoints via system messages + `allowSystemInMessages`), a git-derived `workspaceBrief` project map so the model never re-lists the tree, phase-conditional skills (interview turns load only the first skill), history capped at the last 24 turns, and `read_file` responses capped at 24k chars (head+tail with a truncation marker).
- Updated dependencies [9ddd361]
  - @substrat-run/builder-generator@0.2.0
  - @substrat-run/builder-workspace@0.2.0

## 0.1.0

### Minor Changes

- 3fa5b3f: Mode C (#626): `ContainerWorkspace` — the second implementation of the §3
  Workspace seam, over a Cloudflare Sandbox container, with the same path guard
  and confinement the local mode enforces (structural `SandboxLike`, no
  worker-only deps in the package). `builder.Dockerfile` bakes the monorepo warm
  (pnpm install + full build + a native better-sqlite3 check that fails the
  image, not a session). The hosted studio executes: the BuilderAgent DO runs
  the same turn loop as the local server (ensureVerticalRepo per turn against
  ephemeral disk, generator over the project-rooted workspace, standalone gates,
  commit-per-turn, NDJSON with heartbeat) in a per-project sandbox, with skills
  read from the image and providers resolved from worker secrets (anthropic,
  qwen, compat; ollama refused hosted with the reason). Durability is D-52 made real (#627):
  one git bundle per project in R2 — restored on container wake (clone at HEAD),
  re-bundled after every commit, chunk-safe binary transfer via the SDK's base64
  file encoding, rollback via R2 object versioning. /api/dev preview and the
  hosted picker catalog are named follow-ups.
- e3bfdb1: Hosted shell for the builder studio (#625): staff-only worker at
  builder.substrat.net — OIDC via @substrat-run/oidc-rp plus the control plane's
  staff_actor roster (shared AUTH_DB, read-only, fail closed) gating every path
  including the SPA assets; BuilderAgent DO carrying the local .builder/ state
  (project registry, per-project history, names) under mirrored storage keys;
  cf:deploy + secrets manifest entry (no provider keys in the shell). Execution
  endpoints 503 naming #626 until the ContainerWorkspace lands.
- 8d821e2: The builder studio (internal PoC, builder-studio.md): chat → vertical in the
  browser. A `Workspace` seam with the tier-1 gates and commit-per-turn in
  project-scoped repos under gitignored `.builder/projects/`; a provider-agnostic
  `VerticalGenerator` (any-LLM via the AI SDK — Claude, Qwen/DashScope, Ollama,
  OpenAI-compatible) whose tools are the workspace, with skills as cached prompt
  prefix; a local API server (the BuilderAgent-DO analog) with project registry,
  resumable per-project history, AI-proposed/user-editable names, live NDJSON
  streaming with heartbeat + stall detection, plan tool with assumption chips,
  and a Run manager for the generated app; a React UI in design-system tokens
  (chat · code · preview · gates, Monaco, model picker with hosting disclosure).

### Patch Changes

- c67d6f9: Worker-safe `/edge` subpath entry for builder-workspace (only worker-provable
  modules — LocalWorkspace's node:\* stays behind the root entry), nodejs_compat
  for the sandbox SDK, and the idempotent provision script with account pinning
  and secrets-prefix near-miss detection.
- Updated dependencies [3fa5b3f]
- Updated dependencies [c67d6f9]
- Updated dependencies [8d821e2]
  - @substrat-run/builder-workspace@0.1.0
  - @substrat-run/builder-generator@0.1.0
  - @substrat-run/kernel@0.65.0
