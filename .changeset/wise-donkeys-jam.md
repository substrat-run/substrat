---
'create-substrat': minor
---

A scaffolded vertical ships `.claude/launch.json`, so Claude Desktop starts its dev server,
opens it in the Browser pane, and verifies its own changes there (#752).

The dev topology is declared in the neutral `substrat.devServers` block of `package.json` —
the block `substrat push` and the SessionStart hook already read — and the client file is
emitted from it, because an adapter may trigger but may not *hold* substance
(design/agent-surface.md §3). A declaration names the env var that moves a port and the file
that binds it; the number itself is read out of that file, so the launch file cannot drift
from the server it starts.

This matters most for the part tests cannot reach: a scenario test composes the host
directly and never boots `src/server.ts`, so the HTTP layer is exactly what an agent needs a
browser to check.
