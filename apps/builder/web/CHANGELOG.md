# @substrat-run/builder-web

## 0.3.3

### Patch Changes

- Updated dependencies [8a2da00]
  - @substrat-run/ui@0.2.1

## 0.3.2

### Patch Changes

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

## 0.3.1

### Patch Changes

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

## 0.3.0

### Minor Changes

- af611db: feat(builder-web): OpenCode-style composer — model picker in the prompt box, arrow send, file attachments

  The chat composer becomes one rounded card: textarea on top, a controls row
  below with a `+` attach button, the model chip (moved out of the header —
  opens the same picker), and a square `↑` send button that turns into `■` stop
  while a turn runs. Files attach via the `+` button or by dropping them
  anywhere on the chat column (dashed overlay, staged as removable chips) and
  are saved to the project as `attachments/<name>` through the existing
  `PUT /api/file` seam — both hosts already serve it — with the sent message
  naming the paths so the generator reads them with its normal workspace tools.
  Honest v1 bounds: text files only (null-byte check), 512KB cap — the
  generator could not open a binary anyway. A failed save keeps the draft and
  chips instead of losing them.

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

## 0.2.0

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

## 0.1.3

### Patch Changes

- b4b44dd: Builder generated rate card (harness RFC row 1): the rate card is now a checked-in snapshot generated by `apps/builder/scripts/update-rate-card.mjs` from models.dev cross-checked against LiteLLM (offline via `MODELS_DEV_JSON`/`LITELLM_JSON`), covering cache read/write rates and DashScope's all-or-nothing context tiers — fixing the flat-card undercharge of up to ~2.5× on long-context qwen turns. Usage events now carry per-step token counts (`stepUsage`) so tier selection prices each request in the tier its own input landed in, and per-model costs record as `ai.cost.usd.<model>` meters at record time.
- b4b44dd: Builder provider retry (harness RFC row 2): transient provider failures mid-turn (429, 5xx incl. 529 overloaded, network resets, timeouts) are retried with jittered exponential backoff (2s base → 30s cap, 5 attempts) honouring `retry-after`/`retry-after-ms` capped at 60s, resuming from the captured step transcript so a 30-step build and its cache investment survive one bad request. Context overflow is classified separately and never retried (the same request would overflow again — the future condensation path); client errors surface immediately through the provider-specific explainError. A new `retry` BuildEvent renders the wait as patience, not a hang.

## 0.1.2

### Patch Changes

- 61ca920: Auto model pairs: `<provider>:auto` resolves per phase — the pair's `fast` model runs interview turns, `strong` runs scaffold/iterate (`model-pairs.ts`, shared by both hosts so the pair the picker shows is the pair the turn loop runs). Declared pairs: qwen (`qwen3.6-flash` / `qwen3.8-max`, ids verified against the DashScope catalog) and anthropic (`claude-sonnet-5` / `claude-opus-5`). Pairs never cross a provider — the provider choice is the D-53 consent boundary. The local default is now `qwen:auto` (cheap testing era; weak-model runs double as adversarial QA for the mechanical guards); the hosted default is unchanged. The picker renders the pair as one selectable "auto" row naming both members, with every concrete model still selectable as an override.
- 7dd4478: Builder interview UX: the chat renders Markdown (marked + DOMPurify — plain text was the "formatting isn't working" bug); `ask_user` may be called up to 4 times per turn for coupled questions, each with a short `header`, and the UI groups them into a tabbed block answered as one combined message; every question gets an inline free-text "Other" answer; `project-named` renders as an event line instead of leaking raw JSON. The interview→scaffold dead end is now mechanically impossible: a new `denyWrite` seam on the workspace tools refuses every non-`spec/**` write during interview-phase turns (`interviewWriteGuard` in `phase.ts`, wired in both hosts), so a model cannot scaffold past an unwritten `spec/concept.md` — the refusal names the one action that unblocks it, and the prompt + interview skill spell out the approval-turn sequence (write concept → `set_project_name` → end turn). New Concept tab renders `spec/concept.md` as a reading view and auto-opens the moment the model writes it.
- daae495: Builder usage pricing: the studio's meter keys now carry the model as the billing dimension (`ai.tokens.{input,output}.<provider:modelId>`, configured lazily per model — engine-metering's "subject ≠ meter dimension" rule, since price varies by model), and a vertical-side rate card (`pricing.ts`, D-E: the engine owns quantities, never prices) prices each model's tokens at provider list + 20% markup. Seeded with Qwen 3.6 Flash ($0.19/$1.13 per 1M in/out) and Qwen 3.8 Max ($2.00/$6.00), longest-prefix matched so dated snapshots price as their base model. `/api/usage` gains `byModel` rows with `listUsd`/`billedUsd` (exact decimal strings via contracts helpers; token-millions convert exactly at 6 dp) plus a `cost` rollup that only sums priced rows — models without a rate card entry (all Anthropic models today) count as `unpricedTokens`, never a guessed $0. The Usage pane shows a cost tile and a per-model table with list and billed columns; pre-model v0 entries fold in as unattributed.

## 0.1.1

### Patch Changes

- cf96565: The Usage tab (#646): the studio visualizes its own token spend. A worker
  route (`GET /api/usage`) rolls the metering scope's ledger up host-side
  (totals, per-UTC-day, per-project), and the SPA renders it as stat tiles, a
  stacked daily bar chart (input + output tokens, last 30 days, per-theme
  palettes validated for CVD/contrast), and a per-project table doubling as the
  chart's accessible view. Local mode serves an honest empty report — the Node
  server runs no metering scope, so the pane shows its empty state rather than
  a fake number.

## 0.1.0

### Minor Changes

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
