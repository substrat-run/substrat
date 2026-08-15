# @substrat-run/builder-workspace

## 0.6.0

### Minor Changes

- 76dedea: Truncated turns continue instead of burning the repair budget, and the skills absorb the lessons from the first real studio build.

  **Continuation passes on step-ceiling truncation.** A pass that ends `truncated`
  was cut mid-work — that is "not done yet", not "done but broken", but the hosts
  gated the half-finished tree anyway: the gates went red on incompleteness, and
  the whole `MAX_GATE_REPAIRS` budget was spent on mere continuation under a
  misleading "fix the failures" framing (observed: a scaffold converging over
  initial + 2 repairs, then stalling red until the builder typed "continue").
  All three hosts (local server, hosted DO, dev CLI) now drive `runToCompletion`:
  while a pass ends truncated, re-prompt with `continuationPrompt` — "pick up
  exactly where you left off, do not start over" — BEFORE the gates run. The cap
  (`MAX_CONTINUATIONS = 2`) is per turn and shared across the first pass and
  repair passes; both policy pieces live in gates.ts beside `MAX_GATE_REPAIRS`
  so the hosts cannot drift. Worst case is now 5 model runs per turn (1 + 2
  continuations + 2 repairs), and the repair budget is reserved for genuine
  breakage.

  **iterate.md: four scenario pitfalls from the run's gate-repair rounds.**
  Principal ids are `ulid()`-minted (the kernel Zod-validates the actor — a
  readable `usr-admin-001` fails deep in the first `ctx.emit`); every checked
  permission is granted to a role in the same edit; JOIN columns are qualified
  from the start; and denial semantics — op-level `assertAllowed` throws, only a
  portal proof-walk returns a filtered list — decide what the attacker step
  asserts.

  **The HTTP layer joins the oracle.** The scenario test bypasses server.ts, so
  the model shipped an oracle-shaped stub: per-request `:memory:` host, hardcoded
  tenant/scope, an unused cast loader, and `node:http` hand-wired to `app.fetch`.
  scaffold.md now mandates the Callout shape — `routes.ts` exporting
  `mountApi(app, resolveStub)` with one explicit route per operation, server.ts
  as boot-only harness (host built once on `.data/`, cast loaded at boot,
  `@hono/node-server`) — and iterate.md specifies `test/server.test.ts`: drive
  the mounted app via `app.request()`, assert the 401/403 mapping and that a
  second request sees the first one's write. The suite gate runs every test
  file, so the smoke test is gate-enforced with no new gate machinery.

  **The interview asks about screens, and knows when it's done.** No question
  covered what each persona looks at, the concept template had no place to
  record it, and scaffold.md only built `app/` "when the concept wants a UI" —
  so silence propagated to no UI. New interview question 6 (screens per
  persona), new concept section 8 (one line per persona; "API-only" valid but
  explicit), and `app/` is built whenever the Screens section names one. A new
  readiness rule stops the concept from being proposed while any checklist item
  is open: anything the model would have to invent is its next question, with
  the converse guard (never re-ask, never over-drill, 2–4 rounds typical).

- 2daf512: The studio's file tree no longer wakes the sandbox container to read.

  **Why it was sluggish:** every click in the hosted code pane was a
  browser → worker gate → BuilderAgent DO → Sandbox DO → container-bridge round
  trip — one per directory level, refetched for every expanded directory after
  each turn — and the first click after ~10 idle minutes (the containers-default
  `sleepAfter`) blocked on a full container cold start. `GET /api/files` also ran
  the restore probe per listing. The CodePane comment claimed reads "never need
  the sandbox awake"; hosted reads did.

  **Tree snapshots (`snapshotWorkspace`, builder-workspace).** One JSON object of
  the vertical's working tree — `git ls-files -c -o --exclude-standard`, so
  tracked plus untracked-but-not-ignored, path-normalized across both git modes;
  binary/oversize files are listed in `skipped`, never silently dropped. Lives
  above the `Workspace` seam so both hosts serve the identical shape.

  **Hosted:** the agent writes `projects/<id>/snapshot.json` to R2 right after
  the post-commit bundle (best-effort — a failed rebuild never fails the turn),
  patches it on studio saves, and serves it whole from R2 via `GET /api/snapshot`
  — the container stays asleep. A legacy project builds one lazily from the
  container once. **Local:** the same route, built live from disk per request.

  **SPA:** one snapshot fetch per refresh; tree expansion and file opens are
  instant local operations, saves patch the in-memory copy, and a turn finishing
  triggers a single refetch instead of one per expanded directory. Hosts without
  a snapshot (pre-first-commit) fall back to the per-directory endpoints, which
  are unchanged.

  **Worker gate:** membership lookups now go through a 60s per-isolate cache —
  the short-TTL trade the gate comment had already named — so file clicks stop
  paying a control-plane subrequest each (staff paid it on every `/api/*`
  dispatch; non-staff on every request including assets). Revocation lags by at
  most the TTL.

  The generator's path is deliberately untouched: during a turn the container is
  awake by necessity, and the model must read its own uncommitted writes, which a
  commit-time snapshot would not have.

## 0.5.0

### Minor Changes

- 63c69c0: Two fixes from the truncated todo-app run, plus the skill gap behind its typecheck red.

  **tsc's exit 2 no longer mutes the repair loop.** The 0/1/2 "exit 2 = blocked"
  convention belongs to Substrat's own checkers and is now opt-in per gate
  (`exitConvention: 'substrat'` — boundary-lint and the diff linters). It had been
  applied to every gate, and tsc exits 2 on ordinary type errors — so the gate
  that fails most reported `blocked`, `repairNeeded()` saw nothing to repair,
  `gateReport()` carried nothing into the next turn, and the model was explicitly
  told its own type errors were "NOT a code problem". External tools now fail on
  any nonzero exit; the tri-state convention survives only where a tool actually
  speaks it.

  **qwen gets a working prompt cache (explicit markers at the wire).** DashScope's
  context cache is per-model: qwen3.8-max caches implicitly, but the flash tier
  caches only with explicit Anthropic-style `cache_control` markers on content
  blocks — which `@ai-sdk/openai-compatible` cannot emit (its providerOptions
  spread lands message-level; verified silently ignored). New `qwenCacheFetch`
  (apps/builder/src/qwen-cache.ts) rewrites each chat/completions body at the
  wire — markers on the system prefix and the request's tail, stateless per
  request, so the moving-breakpoint strategy comes free — and both provider hosts
  wire it in. The generator treats `qwen/*` as a cache-stable dialect: no
  stale-payload pruning, same reasoning as the Anthropic branch. Verified
  end-to-end against the token-plan gateway: 99.97% of a tool-loop-shaped prompt
  read from cache on the warm request (reads bill at 10%, creation at 125%,
  5-minute TTL). A 1M-input build turn on flash drops roughly 85–90% in input
  cost.

  **scaffold.md teaches the branded-id boundary.** The todo-app red was the model
  guessing `getScope(tenantId, scopeId, principal)` (it takes the principal
  FIRST) and hand-rolling an `as`-cast for a zod-branded `PrincipalId`. The
  server-harness section now shows the exact call shape and the rule: re-brand
  serialized ids with `principalId.parse(...)` at the boundary, pass through ids
  minted in-process.

## 0.4.0

### Minor Changes

- 022c8ab: Builder turn hardening — four fixes from the first hosted FamilyFlow run.

  **Gate feedback reaches the hosted agent (H5 port).** The `BuilderAgent` DO now
  does what the local server and dev CLI already did: a red run's `gateReport`
  persists in project state and rides into the next turn's context, and every red
  turn drives the capped in-turn repair loop. Previously the hosted model never
  saw a failing gate's output — not even when the builder asked about it.

  **`pnpm install` is a host responsibility.** `runTurn` installs mechanically
  (new `runInstall`, reported as an `install` gate result) when the turn touched
  a package.json or the vertical has one with no `node_modules` — a fresh
  project under `.builder/projects/*` postdates the image's warm install, and
  leaving the install to the model by prompt lost to the step ceiling, after
  which every gate failed with phantom module-not-found errors. A failed install
  reaches the model as pnpm's own output, not as type errors.

  **Step-ceiling cuts are said out loud.** A clean stream end whose final step
  still wanted tools means `stopWhen` truncated the turn: the generator now emits
  a `truncated` event, and all three hosts spell it into durable history via the
  shared `historyMarker` helper — a cut-off turn no longer reads as a finished
  one to the UI or to the model's own next turn.

  **`ask_user` discipline is enforced, not prompted.** The tool now refuses
  duplicate questions (normalized text or tab header already asked this turn) and
  the fifth question of a turn, with an actionable refusal. Questions asked also
  persist into durable history as `[asked …]` markers, so later turns stop
  re-asking what the builder already answered. (Observed: a fast interview model
  asking 11 questions in one turn, three of them duplicates.)

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
