# Substrat — Claude Code plugin

Guided vertical-building on [Substrat](https://substrat.net), for a project you did not
scaffold.

```sh
claude plugin marketplace add https://substrat.net/marketplace.json
claude plugin install substrat@substrat-run
```

In Claude Desktop: **+** → Plugins → Add plugin.

## What it carries

- **`/substrat`** — routes you into the build flow. If the directory is already a Substrat
  vertical it reads that project's `AGENTS.md` and `.substrat/playbook.md`; if it is empty
  it scaffolds one with `npm create substrat` first.
- **`/substrat-help`** — what the plugin can do, and which skill fits. The discovery
  surface for everything else here.
- **`/substrat-plugin-init`** — writes the knowledge import (`CLAUDE.md` → `AGENTS.md`)
  into a vertical the scaffold never reached, and records the kernel version the session
  hook reports against. Re-run it after upgrading the plugin.
- **`/substrat-deploy`** — `substrat login` → `substrat push --promote prod`, and the two
  acknowledgement checkpoints. Our ack flags make deploying a *safer* thing to guide than
  most deploy automation, because the human stop is already mechanical: the skill's job is
  to present the permission and migration diffs well, never to click through them.
- **A `SessionStart` hook** — silent in any project that is not a Substrat vertical. In one
  that is, it tells the agent where the rules live and which docs slice describes the kernel
  version actually installed, so it does not answer from a cached memory of a 0.x API.

There is deliberately no `start-dev-server` skill: Claude Desktop runs a project's dev
servers natively, from the topology the vertical already declares.

## What it deliberately does not carry

The build flow itself. That lives in the project, in `.substrat/playbook.md`, pinned to the
kernel installed there. A copy inside the plugin would be a copy that goes stale on its own
schedule, and the rules an agent must not violate are exactly the wrong thing to be stale
about. Every scaffolded project also carries its own copy of this skill and this hook, so
the plugin adds nothing there and stays out of the way.

Source of truth: [`plugin/substrat/`](https://github.com/substrat-run/substrat/tree/main/plugin/substrat)
in the Substrat monorepo. The hook script is emitted from the scaffold template's copy and
`pnpm lint:plugin --check` fails if they diverge.

Apache-2.0.
