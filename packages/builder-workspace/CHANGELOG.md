# @substrat-run/builder-workspace

## 0.3.0

### Minor Changes

- b4b44dd: Builder gate feedback (harness RFC H5): the tier-1 gates' verdict now reaches the model instead of dying at the UI. A red run's report (`gateReport` — failed gates with trimmed output tails; `blocked` listed as do-not-fix facts, since exit 2 means the checker crashed, not the code) persists in project state and rides into the next turn's volatile context beside the workspace brief, deleted the moment the tree goes green. After a red run, both hosts drive a capped in-turn repair loop (`gateRepairPrompt`, `MAX_GATE_REPAIRS = 2` — every attempt is a full billable model run, so the cap is a billing control): repair stops early when an attempt changes no files, never triggers on a chat-only turn over a pre-existing red tree, and repair prompts are recorded verbatim as user turns so the durable transcript stays truthful. Golden-file drift (permissions/api) gets a regenerate-don't-hand-edit hint — the diff remains the human checkpoint. Policy and wording live in `gates.ts`, above the workspace seam, so the server and the dev CLI cannot drift.

## 0.2.0

### Minor Changes

- 9ddd361: Token economy for builder turns: Anthropic prompt caching (stable system+skills prefix and last history message get ephemeral cacheControl breakpoints via system messages + `allowSystemInMessages`), a git-derived `workspaceBrief` project map so the model never re-lists the tree, phase-conditional skills (interview turns load only the first skill), history capped at the last 24 turns, and `read_file` responses capped at 24k chars (head+tail with a truncation marker).

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
