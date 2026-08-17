# @substrat-run/builder

## 0.5.4

### Patch Changes

- Updated dependencies [5601fa9]
- Updated dependencies [81a8c62]
- Updated dependencies [746a885]
- Updated dependencies [ee95fd6]
  - @substrat-run/contracts@0.67.0
  - @substrat-run/kernel@0.67.0
  - @substrat-run/engine-metering@0.1.2
  - @substrat-run/adapter-cloudflare@0.67.0

## 0.5.3

### Patch Changes

- Updated dependencies [954668b]
  - @substrat-run/kernel@0.66.0
  - @substrat-run/adapter-cloudflare@0.66.0
  - @substrat-run/engine-metering@0.1.1
  - @substrat-run/contracts@0.66.0

## 0.5.2

### Patch Changes

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

- Updated dependencies [76dedea]
- Updated dependencies [2daf512]
  - @substrat-run/builder-workspace@0.6.0
  - @substrat-run/builder-generator@0.6.2

## 0.5.1

### Patch Changes

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

- e3b44d0: Builder studio: readable interview options + a lid on Qwen's repetition loops.

  **Interview options stack, one per row.** ask_user options (and the inline
  numbered-prose fallback) rendered in the model picker's wrapping pill row —
  right for short model ids, wrong for sentence-length answers: later options
  started mid-line and read as randomly indented. They now get their own
  `.option-list` (column, left-aligned); the model picker keeps its wrapping row.

  **Qwen sampling gains `topP: 0.8`.** The chat pane streaming long runs of
  underscores (rendered as an `<hr>` once the run landed on its own line) is the
  qwen family falling into a single-token repetition loop mid-turn. The harness
  already pins temperature 0.55 for qwen; it now also sends Qwen's published
  qwen3-coder nucleus setting, plumbed through a new `topP` generator option on
  the same host-declares-per-model path as temperature (H4).

- Updated dependencies [63c69c0]
- Updated dependencies [e3b44d0]
  - @substrat-run/builder-workspace@0.5.0
  - @substrat-run/builder-generator@0.6.1

## 0.5.0

### Minor Changes

- f151676: feat: the `builder` entitlement gates the studio + the console Members view

  Granting someone the builder studio no longer means granting them the control
  plane — and access follows the team, not an email list. The studio's gate is
  now: platform staff OR membership in a tenant holding the `builder`
  entitlement (granted per tenant in the console like any SKU; expiry applied at
  read, so a lapsed trial closes the studio). The CP's identity-tenants lookup
  returns each membership flagged with the entitlement; the studio resolves
  teams once per request, dispatches only into usable ones, and serves a proper
  HTML denied page for browsers (JSON for API callers) with a federated
  switch-account link. The studio-wide `/api/usage` rollup becomes staff-only
  (it is cross-team until metering is per-team) and the SPA hides the Usage tab
  for non-staff via a new `staff` flag on `/api/me`.

  The console's "Members" nav item graduates from Planned to a real view: the
  staff roster with grant/revoke/re-grant over new staff-gated `/api/members*`
  routes on the CP worker. Grants record the acting staff member (`added_by`,
  CP migration 0003); a re-granted staff member keeps their actor so admin-log
  history stays attributed; revoking the last active staff member is refused.
  Design record: builder-studio.md §15.

### Patch Changes

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

- Updated dependencies [022c8ab]
  - @substrat-run/builder-workspace@0.4.0
  - @substrat-run/builder-generator@0.6.0

## 0.4.0

### Minor Changes

- 2d8568f: feat(builder): team-scoped studio — slug URLs, team picker, per-team DOs

  The hosted studio partitions by team (= tenant, dashboard-teams.md). The URL's
  first segment is the team slug (`builder.substrat.net/<team-slug>`, the
  dashboard's scheme verbatim); every API call names its team via
  `x-substrat-tenant`; and each team gets its own BuilderAgent DO
  (`idFromName(tenantId)`), so projects, history, and names partition by tenant.
  Membership is resolved from the shared control plane's identity directory via a
  new service-token-gated `POST /internal/builder/identity-tenants` over a
  service binding. The staff roster remains as an AND-gate until the builder
  entitlement flag exists on plans; the pre-teams shared `'studio'` instance is
  deliberately abandoned, not migrated. Design record: builder-studio.md §14.

## 0.3.0

### Minor Changes

- b4b44dd: feat(builder): edit_file — strict search/replace edits instead of whole-file rewrites (#663 row 3)

  The generator gains an `edit_file` tool (matching pipeline ported from aider,
  Apache-2.0): exact match, uniform-indent-shift, and `...` elision — no fuzzy
  apply; a miss returns a structured reflection (did-you-mean excerpt,
  already-applied hint) the model corrects from. Offered format-per-model:
  frontier providers get it, weak/local models keep whole-file writes by
  declaration (`editToolFor` in model-pairs.ts). Cuts output tokens on the
  common small-change-to-large-file case, which is billed at the strong-model
  output rate.

### Patch Changes

- b4b44dd: Builder gate feedback (harness RFC H5): the tier-1 gates' verdict now reaches the model instead of dying at the UI. A red run's report (`gateReport` — failed gates with trimmed output tails; `blocked` listed as do-not-fix facts, since exit 2 means the checker crashed, not the code) persists in project state and rides into the next turn's volatile context beside the workspace brief, deleted the moment the tree goes green. After a red run, both hosts drive a capped in-turn repair loop (`gateRepairPrompt`, `MAX_GATE_REPAIRS = 2` — every attempt is a full billable model run, so the cap is a billing control): repair stops early when an attempt changes no files, never triggers on a chat-only turn over a pre-existing red tree, and repair prompts are recorded verbatim as user turns so the durable transcript stays truthful. Golden-file drift (permissions/api) gets a regenerate-don't-hand-edit hint — the diff remains the human checkpoint. Policy and wording live in `gates.ts`, above the workspace seam, so the server and the dev CLI cannot drift.
- b4b44dd: Builder generated rate card (harness RFC row 1): the rate card is now a checked-in snapshot generated by `apps/builder/scripts/update-rate-card.mjs` from models.dev cross-checked against LiteLLM (offline via `MODELS_DEV_JSON`/`LITELLM_JSON`), covering cache read/write rates and DashScope's all-or-nothing context tiers — fixing the flat-card undercharge of up to ~2.5× on long-context qwen turns. Usage events now carry per-step token counts (`stepUsage`) so tier selection prices each request in the tier its own input landed in, and per-model costs record as `ai.cost.usd.<model>` meters at record time.
- Updated dependencies [b4b44dd]
- Updated dependencies [b4b44dd]
- Updated dependencies [b4b44dd]
- Updated dependencies [b4b44dd]
- Updated dependencies [b4b44dd]
  - @substrat-run/builder-generator@0.5.0
  - @substrat-run/builder-workspace@0.3.0

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
