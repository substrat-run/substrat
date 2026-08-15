# @substrat-run/builder

## 0.2.3

### Patch Changes

- 61ca920: Auto model pairs: `<provider>:auto` resolves per phase — the pair's `fast` model runs interview turns, `strong` runs scaffold/iterate (`model-pairs.ts`, shared by both hosts so the pair the picker shows is the pair the turn loop runs). Declared pairs: qwen (`qwen3.6-flash` / `qwen3.8-max`, ids verified against the DashScope catalog) and anthropic (`claude-sonnet-5` / `claude-opus-5`). Pairs never cross a provider — the provider choice is the D-53 consent boundary. The local default is now `qwen:auto` (cheap testing era; weak-model runs double as adversarial QA for the mechanical guards); the hosted default is unchanged. The picker renders the pair as one selectable "auto" row naming both members, with every concrete model still selectable as an override.
- e9df025: Cloudflare model listing: Workers AI's OpenAI-compatible surface serves
  chat/completions and embeddings but not `GET /models` — the picker's live
  listing 405'd. Both hosts now read the account catalog instead
  (`…/ai/models/search`, derived from the `/ai/v1` base), filtered server-side
  to Text Generation so the list is models that can actually run a build turn.
  Cloudflare's own `@cf/…` models only; partner-served `vendor/model` ids stay
  free-text.
- 7dd4478: Builder interview UX: the chat renders Markdown (marked + DOMPurify — plain text was the "formatting isn't working" bug); `ask_user` may be called up to 4 times per turn for coupled questions, each with a short `header`, and the UI groups them into a tabbed block answered as one combined message; every question gets an inline free-text "Other" answer; `project-named` renders as an event line instead of leaking raw JSON. The interview→scaffold dead end is now mechanically impossible: a new `denyWrite` seam on the workspace tools refuses every non-`spec/**` write during interview-phase turns (`interviewWriteGuard` in `phase.ts`, wired in both hosts), so a model cannot scaffold past an unwritten `spec/concept.md` — the refusal names the one action that unblocks it, and the prompt + interview skill spell out the approval-turn sequence (write concept → `set_project_name` → end turn). New Concept tab renders `spec/concept.md` as a reading view and auto-opens the moment the model writes it.
- daae495: Builder usage pricing: the studio's meter keys now carry the model as the billing dimension (`ai.tokens.{input,output}.<provider:modelId>`, configured lazily per model — engine-metering's "subject ≠ meter dimension" rule, since price varies by model), and a vertical-side rate card (`pricing.ts`, D-E: the engine owns quantities, never prices) prices each model's tokens at provider list + 20% markup. Seeded with Qwen 3.6 Flash ($0.19/$1.13 per 1M in/out) and Qwen 3.8 Max ($2.00/$6.00), longest-prefix matched so dated snapshots price as their base model. `/api/usage` gains `byModel` rows with `listUsd`/`billedUsd` (exact decimal strings via contracts helpers; token-millions convert exactly at 6 dp) plus a `cost` rollup that only sums priced rows — models without a rate card entry (all Anthropic models today) count as `unpricedTokens`, never a guessed $0. The Usage pane shows a cost tile and a per-model table with list and billed columns; pre-model v0 entries fold in as unattributed.
- Updated dependencies [7dd4478]
  - @substrat-run/builder-generator@0.4.0

## 0.2.2

### Patch Changes

- 5145cd1: Hosted studio: the model picker now works. `GET /api/providers` and `GET /api/models`
  were still falling through to the "not hosted yet" 503, so the picker on
  builder.substrat.net rendered no provider rows and every session was pinned to the
  default `anthropic:claude-opus-5` — even when the only credentials deployed were
  Qwen/Cloudflare worker secrets. `providers-worker.ts` now serves the hosted catalog
  (the same four providers `resolveModelHosted` can run, with the D-53 who/where/what
  disclosure and `credential.set` read from worker secrets) plus live `/models` listing
  for the OpenAI-compatible endpoints, and the DO routes both endpoints.
- cf96565: The Usage tab (#646): the studio visualizes its own token spend. A worker
  route (`GET /api/usage`) rolls the metering scope's ledger up host-side
  (totals, per-UTC-day, per-project), and the SPA renders it as stat tiles, a
  stacked daily bar chart (input + output tokens, last 30 days, per-theme
  palettes validated for CVD/contrast), and a per-project table doubling as the
  chart's accessible view. Local mode serves an honest empty report — the Node
  server runs no metering scope, so the pane shows its empty state rather than
  a fake number.

## 0.2.1

### Patch Changes

- cff86ee: Builder-distilled skills + the phase ladder (D-54/D-55). The generator's skills are now studio-owned files under `apps/builder/skills/` — the repo's Claude Code skills assumed monorepo access and denied tools — split four ways (`platform`, `interview`, `scaffold`, `iterate`) and gated by a phase ladder derived from workspace facts: interview (no `spec/concept.md`), scaffold (no `src/module.ts` yet), iterate. A shared manifest (`phase.ts`) drives both hosts, so prefix content changes only at phase boundaries and each phase's prefix caches independently; mature-project turns drop the ~5k of scaffolding skeletons. A new `phase` BuildEvent (studio-emitted, never model-claimed) feeds a top-bar phase stepper in the UI — what the user sees is exactly what the generator is loaded for. Also fixes the hosted host detecting the phase before the R2 restore (a slept container read an empty disk and loaded interview skills for mature projects).
- 02d114e: The studio records its token spend (#646): the builder worker gains its own
  CP-less kernel scope — a `ScopeDO` bundling only the metering engine,
  provisioned via `provisionScopeLocal` under a fixed studio node — and the
  turn loop reports each turn's `usage` event into it: two counter entries
  (`ai.tokens.input`/`ai.tokens.output`), subject = the project ref, dedupe
  key = the turn's ulid, so a replayed report can never double-bill.
  Recording is best-effort by design: the turn's product is the commit, and a
  metering outage logs a miss rather than failing the turn. This is the first
  brick of the builder's record-keeping half becoming a vertical (D-31/D-33);
  when builder teams arrive, recording moves to per-team scopes and the fixed
  node retires.
- c3631be: Studio project-menu polish: the project dropdown now closes on outside click and Escape (document-level pointerdown/keydown listeners scoped to while it is open), and "New project" opens a styled modal — the model-picker shell sized down to a single input with Cancel/Create — instead of the browser-native `window.prompt()`. Enter creates, Escape or backdrop click cancels, and an empty name still lets the AI name the project at concept time.
- 92fd9a8: Step-level token economy. The tool loop re-sends the whole growing transcript on every step, so this is where the bill actually lives: on the Anthropic dialect a moving cache breakpoint (`prepareStep`) makes each step read the prior transcript from cache instead of re-billing it; on OpenAI-compatible dialects, stale tool payloads (an old `write_file` body superseded by a later write, an outdated `read_file` result, a re-run command's old log) are stubbed since there is no placeable cache there. The volatile workspace brief moves out of the pre-history prefix into the final user message so it stops invalidating the conversation cache; successful `run_command` output is capped at a 1.5k tail (failures keep 8k). Usage events now report the whole turn (`totalUsage`, not final-step-only — the old number under-reported multi-step turns) plus cache read/write splits, rendered per turn and per session in the studio UI.
- Updated dependencies [cff86ee]
- Updated dependencies [92fd9a8]
- Updated dependencies [f4529ed]
  - @substrat-run/builder-generator@0.3.0
  - @substrat-run/engine-metering@0.1.0

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
