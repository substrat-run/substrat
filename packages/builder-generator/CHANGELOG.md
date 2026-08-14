# @substrat-run/builder-generator

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
