---
name: substrat-help
description: List what the Substrat plugin can do and which of its skills fits the situation — build a vertical, wire an existing project, deploy to prod. Use when the user asks what this plugin offers, says "substrat help", or is not sure which Substrat command to reach for.
---

# What the Substrat plugin can do

Substrat is a multi-tenant kernel (tenancy, permissions, events, migrations) plus headless
**engines** that own invariants, and **verticals** that own everything a user touches. This
plugin is the Claude Code adapter for it, for a project you did not scaffold.

Print the table below for the user, then ask which one they want — or, if what they
described already picks one, say which and go.

| Ask | Skill | What it does |
|---|---|---|
| "build me a …", "scaffold a vertical", "add a feature to this vertical" | `substrat` | Routes into the build flow. Scaffolds with `npm create substrat` if the directory is empty, then reads the project's own `AGENTS.md` and `.substrat/playbook.md` and follows those. |
| "wire this project up", "the agent doesn't know the rules" | `substrat-plugin-init` | Writes the knowledge import (`CLAUDE.md` → `AGENTS.md`) into a project that has none, and records the kernel version the session hook reports against. Re-run it after upgrading the plugin. |
| "ship it", "deploy to prod" | `substrat-deploy` | `substrat login` → `substrat push --promote prod`, and presents the permission / migration checkpoints when a promotion is refused until they are acknowledged. |

Plus a **SessionStart hook**, which needs no invoking: it is silent in any project that is
not a Substrat vertical, and in one that is, it says where the rules live and which docs
slice matches the kernel version actually installed. Opt out with
`.substrat/no-session-context`.

## What this plugin deliberately does not carry

The build flow, and the rules. Those live in the project — `.substrat/playbook.md` and
`AGENTS.md` — pinned to the kernel installed there. Substrat is pre-1.0 and its interfaces
change without notice, so a second copy inside a plugin would go stale on its own schedule,
and the rules an agent must not violate are exactly the wrong thing to be stale about.

So when a question is about *the platform*, do not answer it from memory. The docs are
machine-readable: `https://substrat.net/llms.txt` is the index, every page has a `.md`
twin, and `https://substrat.net/guide/agent-rules` is the rules file itself — including the
symptom → fix table for the failures that point somewhere other than their cause.

## Two things the plugin will not do for you

- **Self-approve a checkpoint.** A migration diff and a permission diff are read and
  approved by a person. Neither this plugin nor any subagent it spawns may click through
  one.
- **Skip the design gate.** A user with zero Substrat knowledge gets to say "yes, that's
  the app I want" before implementation, not after.
