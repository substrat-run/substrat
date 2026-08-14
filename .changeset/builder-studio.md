---
"@substrat-run/builder-workspace": minor
"@substrat-run/builder-generator": minor
"@substrat-run/builder": minor
"@substrat-run/builder-web": minor
---

The builder studio (internal PoC, builder-studio.md): chat → vertical in the
browser. A `Workspace` seam with the tier-1 gates and commit-per-turn in
project-scoped repos under gitignored `.builder/projects/`; a provider-agnostic
`VerticalGenerator` (any-LLM via the AI SDK — Claude, Qwen/DashScope, Ollama,
OpenAI-compatible) whose tools are the workspace, with skills as cached prompt
prefix; a local API server (the BuilderAgent-DO analog) with project registry,
resumable per-project history, AI-proposed/user-editable names, live NDJSON
streaming with heartbeat + stall detection, plan tool with assumption chips,
and a Run manager for the generated app; a React UI in design-system tokens
(chat · code · preview · gates, Monaco, model picker with hosting disclosure).
