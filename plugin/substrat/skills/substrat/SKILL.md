---
name: substrat
description: Build a multi-tenant business app on Substrat — interview the user, map their domain onto the engines, land a design document they approve before any code, then build it. Use when the user mentions Substrat or substrat-run, or asks to build a multi-tenant business app / vertical / internal tool where tenancy, permissions, audit, or work-order-shaped workflows matter (field service, workshops, repairs, inspections, checklists, invoicing).
---

# Build a vertical on Substrat

Substrat is a multi-tenant kernel (tenancy, permissions, events, migrations) plus headless
**engines** that own invariants, and **verticals** that own everything a user touches.

**This skill routes; it does not carry the flow.** The flow lives in the project, in
`.substrat/playbook.md`, next to the `AGENTS.md` rules — and that copy is pinned to the
kernel version actually installed there. Substrat is 0.x and its interfaces change without
notice, so a flow carried here would be a second copy that goes stale silently. Get the
project first, then read its playbook.

Work out which of the three situations you are in, then follow it.

## 1. The directory is already a Substrat vertical

`package.json` has a `substrat` block.

1. Read `AGENTS.md` — the always-on rules. Module-code boundaries, the gates, and the two
   checkpoints you may never self-approve.
2. Read `.substrat/playbook.md` and follow it. Start at Step 1 for a new app; jump to the
   step that fits for an extension.

Do not substitute anything you remember about Substrat for what those two files say.

## 2. The directory is empty, or has nothing you would be overwriting

Scaffold first, then you are in situation 1.

1. Ask the user for a short project name if you do not already have one from what they
   said. One question, not an interview — the interview is Step 1 of the playbook and
   happens inside the project, where its output can be checked in.
2. Run `npm create substrat <dir>` (or `npm create substrat .` to scaffold in place).
3. Install, then go to situation 1 and read the two files it wrote.

The scaffold is not an empty skeleton: it ships a small working vertical (a bike-repair
shop on `engine-workorder` + `engine-invoicing`) that is green out of the box. The playbook's
build step reshapes that into the user's domain rather than starting from nothing.

Scaffolding before the design gate is deliberate. The playbook writes `spec/concept.md`
into the project at Step 3 and the user approves it at Step 4 — both want a project to
live in, and
neither is made safer by the agent holding the design in its head first.

## 3. An existing project that is not a Substrat vertical

Say so plainly rather than improvising. `npm create substrat` scaffolds a project; it does
not convert one, and Substrat is not a library you add to an existing app — a vertical is
the app. Ask the user whether they want a new Substrat project alongside what they have.

If they want to understand the platform before deciding, the docs are machine-readable:
`https://substrat.net/llms.txt` is the index and every page has a `.md` twin. Read those
rather than answering from memory.

---

## When something breaks and the symptom points nowhere

A Zod error naming nothing you wrote, a green test suite over a broken app, a kill that
takes down someone else's dev server. The rules file carries a **symptom → fix** table for
exactly those — the failures whose symptom is somewhere other than their cause. It is
`AGENTS.md` in the project, and <https://substrat.net/guide/agent-rules> published. Read
the row before debugging from first principles.

## Two things that hold in every situation

- **The two human checkpoints are hard stops.** A migration diff and a permission diff are
  read and approved by a person. You may never self-approve them, and neither may any
  subagent you spawn. The playbook says when they land.
- **The design gate is a hard stop too**, and it is upstream of both. A user with zero
  Substrat knowledge gets to say "yes, that's the app I want" before implementation, not
  after.
