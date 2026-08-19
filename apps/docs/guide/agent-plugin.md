# The Claude Code plugin

A scaffolded Substrat project already teaches an agent what it needs: `npm create substrat`
writes the rules, the build playbook, and a session hook that pins the agent to the docs for
the kernel version installed there. The plugin exists for the case before that — an agent
opened on a directory we did not generate, which has none of it.

```sh
claude plugin marketplace add https://substrat.net/marketplace.json
claude plugin install substrat@substrat-run
```

In Claude Desktop, install it from **+** → **Plugins** → **Add plugin**. Plugins are not
available in WSL sessions.

The marketplace also resolves from the repository, if you prefer that form:

```sh
claude plugin marketplace add substrat-run/substrat
```

Both register the same catalog. The URL form downloads one small file; the repository form
clones the monorepo, so prefer the URL unless you have a reason not to.

## What you get

**`/substrat`** — the guided build flow. It works out which of three situations you are in
and routes accordingly: an existing Substrat vertical (read its rules and playbook), an
empty directory (scaffold one first, then the same), or an existing project that is not a
vertical (say so, rather than improvise — Substrat is not a library you add to an app).

**A `SessionStart` hook** — silent in any project that is not a Substrat vertical, so it
costs you nothing elsewhere. In one that is, it tells the agent where the rules live and
which docs slice describes the kernel actually installed. Substrat is pre-1.0 and its
interfaces change without notice, so an agent working from pages it cached two minors ago is
the expensive failure: confident, plausible, wrong.

## What it deliberately does not contain

The build flow itself. That lives in the project, in `.substrat/playbook.md`, beside the
[agent rules](./agent-rules.md) in `AGENTS.md` — and that copy is pinned to the kernel
version installed there. A copy inside the plugin would go stale on its own schedule, and
the rules an agent must not violate are the worst possible thing to be stale about. The
plugin routes to the project's copy and never substitutes for it.

This is why the plugin adds nothing to a project you scaffolded: that project already
carries its own copy of the skill and the hook. Installing it anyway is harmless — the
project's copies win — but it is not something you need to do.

## Other tools

The plugin is a Claude Code adapter. Every other client reads the same neutral core, which
the scaffold writes into the project directly:

| Tool | How it finds the rules |
| --- | --- |
| Claude Code | `CLAUDE.md`, `.claude/skills/`, `.claude/settings.json`, `.claude/launch.json` |
| Cursor | `.cursor/rules/substrat.mdc`, `.cursor/commands/new-vertical.md` |
| opencode | `.opencode/command/new-vertical.md` |
| Codex, Kiro | `AGENTS.md`, natively — nothing to install |

For an agent that has not scaffolded anything and is reading rather than building,
[`substrat.net/llms.txt`](https://substrat.net/llms.txt) is the docs index and every page on
this site has a `.md` twin at the same URL.
