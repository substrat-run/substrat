---
'create-substrat': minor
---

`npm create substrat <dir>` now scaffolds a real project instead of printing a
placeholder message.

The initializer copies a **tool-agnostic instruction layer** into the new project so
Claude Code, Cursor, and opencode all read the same rules and build flow from one source:

- **`AGENTS.md`** — the always-on constitution (module-code boundaries, the gates, the two
  human checkpoints). Read by every tool; `CLAUDE.md` is a one-line `@AGENTS.md` import so
  Claude sees it too without a symlink.
- **`.substrat/playbook.md`** — the interview → coverage-map → scaffold → run → checkpoints
  flow, as a single source of truth. Its Step 8 now updates `AGENTS.md` (which every tool
  reads) rather than a Claude-only file, so a vertical stays multi-tool-competent for the
  next session in any editor.
- **Per-tool entry points** that all point at the playbook: a thin Claude skill (keeps
  `/substrat` + progressive disclosure), a Cursor command + rule, and an opencode command.

It also generates the tooling configs that need the project name interpolated
(`package.json` with the published `@substrat-run/*` deps and no `zod`, `tsconfig.json`,
`vitest.config.ts`, `.gitignore`, `README.md`), refuses to overwrite an existing project,
and stays dependency-free (node built-ins only).

The reference vertical (`src/*` + scenario test) is not shipped yet — a fresh scaffold
installs and is ready for the agent to build the vertical, guided by the playbook.
