# @substrat-run/builder-generator

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
