---
name: substrat-plugin-init
description: Wire an existing Substrat vertical into this agent — write the knowledge import (CLAUDE.md → AGENTS.md) that a project scaffolded before the convention existed is missing, and record the kernel version the session hook reports against. Use when a Substrat project has no AGENTS.md or no CLAUDE.md import, or after upgrading the Substrat plugin.
---

# Wire an existing Substrat project into this agent

`npm create substrat` writes the agent wiring into every project it generates. This skill
is for the ones it never reached: a vertical scaffolded before the convention existed, a
project someone assembled by hand, or a checkout where the wiring was removed. It writes
the same files the scaffold would, and nothing else.

**It carries no rules.** Everything it writes either points at the project's own
`AGENTS.md` or *is* the published copy of it. If you find yourself typing a rule into a
file here, stop — the rule belongs in `AGENTS.md`, which is the one file every tool reads.

## 0. Refuse early if this is not a vertical

Read `package.json`. If it has no `substrat` block, this is not a Substrat vertical, and
adding Substrat rules to it would be wrong rather than merely useless. Say so, and offer
`npm create substrat` in a new directory instead (the `substrat` skill does that).

Re-running this skill on an already-wired project is fine and expected — that is what
happens after a plugin upgrade. Every step below is idempotent, and every step that would
overwrite a file the user maintains asks first.

## 1. Ask which file carries the rules

One question, with a default:

> Substrat's rules file is `AGENTS.md` — the tool-neutral name Codex, Cursor, opencode and
> Kiro already read. Claude Code reads `CLAUDE.md`, so it gets a one-line `@AGENTS.md`
> import. Shall I write it that way, or do you want everything in `CLAUDE.md`?

Take `AGENTS.md` + the import unless they say otherwise. Two files with one source beats
one file that only one tool can read.

## 2. Write the rules file, if it is missing

If `AGENTS.md` already exists, **do not overwrite it** — show the user what it has and stop
at step 3. A project's own rules file may have been edited on purpose.

If it is missing, fetch the published copy and write it verbatim:

```
https://substrat.net/guide/agent-rules.md
```

That page is the scaffold's `AGENTS.md`, published — the two are held identical by a CI
gate, so a rule cannot say one thing in a project and another on the website. Drop the
VitePress frontmatter and the `GENERATED` comment at the top of the fetched page; keep
everything from the first `## ` heading down, which is the contract itself.

If the fetch fails (offline, or the site is unreachable), say so and stop rather than
writing rules from memory. A remembered 0.x API is the expensive failure this whole plugin
exists to avoid.

## 3. Write the import

`CLAUDE.md`, exactly:

```md
@AGENTS.md

<!--
Claude Code reads CLAUDE.md, not AGENTS.md. This one-line @-import pulls the shared
constitution in verbatim, so there is a single source of truth every tool reads.
Add Claude-only notes below this line if you ever need them; keep the shared rules in
AGENTS.md so Cursor and opencode see them too.
-->
```

If `CLAUDE.md` already exists and does not import `AGENTS.md`, add the `@AGENTS.md` line at
the top and leave the rest of the file alone. If it already imports it, there is nothing to
do.

## 4. Record the version marker

The SessionStart hook this plugin ships reports which kernel version the project has and
tells the agent which docs slice describes it. It compares against a marker at
`.substrat/.docs-pin`, and announces **the move** — `0.4.1 → 0.5.0` — when the two differ.
With no marker, the first upgrade after this looks like a first sighting, and the one
message worth reading is the one that does not print.

So read the resolved version from `node_modules/@substrat-run/kernel/package.json`
(the resolved one, not the range in `package.json` — a caret on 0.x pins the minor, and the
resolved version is what the code compiles against) and write it, plus a trailing newline,
to `.substrat/.docs-pin`.

If the kernel is not installed yet, skip this step and tell the user to install first; a
marker naming a version that is not there would suppress the announcement it exists for.

## 5. Say what changed, and what did not

Report the files you wrote, and then the two things that are still true:

- **The build flow is not in this plugin.** It is `.substrat/playbook.md` in the project.
  A project the scaffold never reached will not have one — say so, and point at
  `https://substrat.net/llms.txt` for the docs index instead of inventing a flow.
- **The two checkpoints are unchanged.** A migration diff and a permission diff are read
  and approved by a person; nothing this skill wrote makes an agent able to approve one.

Then suggest restarting the session, so the SessionStart hook runs against what you just
wrote.
