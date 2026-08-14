# @substrat-run/builder-web

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
