# @substrat-run/builder-generator

## 0.7.0

### Minor Changes

- 8b05a7f: The model phase (#680): a phase between interview and build whose only artifact is `spec/model.ts`.

  The build was making design decisions and stabilising them through the gates at
  the same time, which is what makes it thrash. Entities, operations, permissions
  and returns are now decided **once**, in an artifact a human approves, before a
  handler exists.

  - `BuildPhase` gains `'model'`; `detectPhase` reads it off the workspace —
    concept approved, no `spec/model.ts` yet.
  - `modelWriteGuard` restricts model turns to `spec/**`, as interview turns are.
  - **`buildWriteGuard` is the mirror, and the direction rule made mechanical:**
    build turns cannot write `spec/model.*` at all. Downstream may _falsify_ the
    model — a handler that cannot return what the model declares is real
    information — but it may not _author_ it. Without this a failing build quietly
    redraws the contract at continuation 14 and everything agrees again, which is
    how 159 operations come to match a model that is wrong 51 times. A genuine
    modelling error stops the build instead.
  - A `model` gate typechecks `spec/model.ts`. That typecheck **is** the check: the
    reference integrity lives in `defineEntities` / `defineOperations`, so a parent
    naming no entity, an `entityIdFrom` naming no output field, or a payload
    carrying an erasable field all fail here — before any module code exists.
  - `skills/model.md` carries the vocabulary, and says what does **not** belong:
    behaviour stays prose, and there is no tenancy annotation because there is
    nothing to forget.

  Also: `BuildPhase` was written out twice — once in `phase.ts`, once in the
  `phase` build event — and the two drifted the moment a phase was added. One
  definition now, in `builder-generator` because a package cannot import from an
  app, re-exported by `phase.ts` where the ladder's semantics live.

### Patch Changes

- Updated dependencies [ac6bf64]
- Updated dependencies [8b05a7f]
  - @substrat-run/builder-workspace@0.7.0

## 0.6.2

### Patch Changes

- Updated dependencies [76dedea]
- Updated dependencies [2daf512]
  - @substrat-run/builder-workspace@0.6.0

## 0.6.1

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
  - @substrat-run/builder-workspace@0.5.0

## 0.6.0

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

### Patch Changes

- Updated dependencies [022c8ab]
  - @substrat-run/builder-workspace@0.4.0

## 0.5.0

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

- b4b44dd: Builder gate feedback (harness RFC H5): the tier-1 gates' verdict now reaches the model instead of dying at the UI. A red run's report (`gateReport` — failed gates with trimmed output tails; `blocked` listed as do-not-fix facts, since exit 2 means the checker crashed, not the code) persists in project state and rides into the next turn's volatile context beside the workspace brief, deleted the moment the tree goes green. After a red run, both hosts drive a capped in-turn repair loop (`gateRepairPrompt`, `MAX_GATE_REPAIRS = 2` — every attempt is a full billable model run, so the cap is a billing control): repair stops early when an attempt changes no files, never triggers on a chat-only turn over a pre-existing red tree, and repair prompts are recorded verbatim as user turns so the durable transcript stays truthful. Golden-file drift (permissions/api) gets a regenerate-don't-hand-edit hint — the diff remains the human checkpoint. Policy and wording live in `gates.ts`, above the workspace seam, so the server and the dev CLI cannot drift.
- b4b44dd: Builder generated rate card (harness RFC row 1): the rate card is now a checked-in snapshot generated by `apps/builder/scripts/update-rate-card.mjs` from models.dev cross-checked against LiteLLM (offline via `MODELS_DEV_JSON`/`LITELLM_JSON`), covering cache read/write rates and DashScope's all-or-nothing context tiers — fixing the flat-card undercharge of up to ~2.5× on long-context qwen turns. Usage events now carry per-step token counts (`stepUsage`) so tier selection prices each request in the tier its own input landed in, and per-model costs record as `ai.cost.usd.<model>` meters at record time.
- b4b44dd: feat(builder-generator): context-overflow recovery — condense and resume (#663 row 5)

  A provider context-overflow error mid-turn no longer kills the turn: the loop
  drops old tool payloads from the transcript (write bodies, tool outputs —
  tool_call/tool_result pairing preserved), keeps the recent working set
  verbatim, and re-issues the failed request. Deterministic and reactive-only —
  no LLM summarizer, nothing to overflow, no cache forfeited until the provider
  has already rejected the transcript. Escalation-capped: gentle pass → drop
  everything droppable → fatal with the provider's message. Qwen temperature
  0.55 and OpenAI promptCacheKey/store:false defaults ride the same release.

- b4b44dd: Builder provider retry (harness RFC row 2): transient provider failures mid-turn (429, 5xx incl. 529 overloaded, network resets, timeouts) are retried with jittered exponential backoff (2s base → 30s cap, 5 attempts) honouring `retry-after`/`retry-after-ms` capped at 60s, resuming from the captured step transcript so a 30-step build and its cache investment survive one bad request. Context overflow is classified separately and never retried (the same request would overflow again — the future condensation path); client errors surface immediately through the provider-specific explainError. A new `retry` BuildEvent renders the wait as patience, not a hang.

### Patch Changes

- Updated dependencies [b4b44dd]
  - @substrat-run/builder-workspace@0.3.0

## 0.4.0

### Minor Changes

- 7dd4478: Builder interview UX: the chat renders Markdown (marked + DOMPurify — plain text was the "formatting isn't working" bug); `ask_user` may be called up to 4 times per turn for coupled questions, each with a short `header`, and the UI groups them into a tabbed block answered as one combined message; every question gets an inline free-text "Other" answer; `project-named` renders as an event line instead of leaking raw JSON. The interview→scaffold dead end is now mechanically impossible: a new `denyWrite` seam on the workspace tools refuses every non-`spec/**` write during interview-phase turns (`interviewWriteGuard` in `phase.ts`, wired in both hosts), so a model cannot scaffold past an unwritten `spec/concept.md` — the refusal names the one action that unblocks it, and the prompt + interview skill spell out the approval-turn sequence (write concept → `set_project_name` → end turn). New Concept tab renders `spec/concept.md` as a reading view and auto-opens the moment the model writes it.

## 0.3.0

### Minor Changes

- cff86ee: Builder-distilled skills + the phase ladder (D-54/D-55). The generator's skills are now studio-owned files under `apps/builder/skills/` — the repo's Claude Code skills assumed monorepo access and denied tools — split four ways (`platform`, `interview`, `scaffold`, `iterate`) and gated by a phase ladder derived from workspace facts: interview (no `spec/concept.md`), scaffold (no `src/module.ts` yet), iterate. A shared manifest (`phase.ts`) drives both hosts, so prefix content changes only at phase boundaries and each phase's prefix caches independently; mature-project turns drop the ~5k of scaffolding skeletons. A new `phase` BuildEvent (studio-emitted, never model-claimed) feeds a top-bar phase stepper in the UI — what the user sees is exactly what the generator is loaded for. Also fixes the hosted host detecting the phase before the R2 restore (a slept container read an empty disk and loaded interview skills for mature projects).
- 92fd9a8: Step-level token economy. The tool loop re-sends the whole growing transcript on every step, so this is where the bill actually lives: on the Anthropic dialect a moving cache breakpoint (`prepareStep`) makes each step read the prior transcript from cache instead of re-billing it; on OpenAI-compatible dialects, stale tool payloads (an old `write_file` body superseded by a later write, an outdated `read_file` result, a re-run command's old log) are stubbed since there is no placeable cache there. The volatile workspace brief moves out of the pre-history prefix into the final user message so it stops invalidating the conversation cache; successful `run_command` output is capped at a 1.5k tail (failures keep 8k). Usage events now report the whole turn (`totalUsage`, not final-step-only — the old number under-reported multi-step turns) plus cache read/write splits, rendered per turn and per session in the studio UI.

## 0.2.0

### Minor Changes

- 9ddd361: Token economy for builder turns: Anthropic prompt caching (stable system+skills prefix and last history message get ephemeral cacheControl breakpoints via system messages + `allowSystemInMessages`), a git-derived `workspaceBrief` project map so the model never re-lists the tree, phase-conditional skills (interview turns load only the first skill), history capped at the last 24 turns, and `read_file` responses capped at 24k chars (head+tail with a truncation marker).

### Patch Changes

- Updated dependencies [9ddd361]
  - @substrat-run/builder-workspace@0.2.0

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

### Patch Changes

- Updated dependencies [3fa5b3f]
- Updated dependencies [c67d6f9]
- Updated dependencies [8d821e2]
  - @substrat-run/builder-workspace@0.1.0
