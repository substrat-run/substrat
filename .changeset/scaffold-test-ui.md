---
"create-substrat": patch
---

A scaffolded project gets `pnpm test:ui`: the live vitest dashboard on `127.0.0.1:5290`, declared as a `tests` entry in `.claude/launch.json` so Claude Desktop's Browser pane can open it. The bare origin redirects to the UI, and the port moves with `VITEST_UI_PORT`. `@vitest/ui` joins the devDependencies.
