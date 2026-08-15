# evals/ — the generator's regression suite

builder-studio.md §9.6, D-51, issue #630. **The skills are the product**: every edit to
a skill file, every model change, every effort adjustment, every harness restructure
changes what every future vertical looks like. This directory is what makes such a
change *reviewable* instead of a leap of faith — the same move `packages/contract-tests`
makes for adapters, applied to the generator.

## What lives here

One directory per fixture:

- `concept.md` — a **frozen** concept document, complete enough that a competent build
  needs no questions. Frozen means frozen: editing a concept invalidates every
  historical result against it; add a new fixture instead.
- `expect.json` — the expected structural outcome, checked from the *outside* (the
  gates and the probe), never fed to the model:
  - `operations` — operation names that must exist in the project's registered modules
  - `roles` — role key → permission keys the role must hold at minimum (superset is
    fine; dropping a pinned key is the regression)
  - `files` — paths that must exist
  - `maxTurns` — optional per-fixture turn ceiling

Gates-green is always required and never declared.

## Running the sweep

```
pnpm builder evals                # all fixtures, default model
pnpm builder evals --eval fixline # one fixture
pnpm builder evals --model qwen:qwen3.8-max
```

Run it **before and after** any change to the skills, the model pairs, the effort, or
the generator harness. Each fixture builds in `.builder/projects/eval-<name>` (wiped at
run start, kept afterwards for autopsy); results land in `.builder/evals/run-*.json`.
The comparison metric between two runs is **token usage per passing build**
(builder-harness.md §4) — the usage events carry it, the report prices it.

Mode A only (§3.1): no container, no Docker — and therefore **no isolation**. The model
gets shell access to this machine once per fixture; run from a scratch clone if the
checkout holds anything sensitive.

## How the verdict is computed

The driver mirrors the studio's turn loop exactly (pass → gates → capped repair, same
`MAX_GATE_REPAIRS`): an eval that drives the generator through a different harness
measures the wrong thing. Structural expectations are read by importing the project's
own `MODULES` + `ROLES` exports — the same objects `pnpm lint:permissions` renders —
so an operation that exists only in prose does not exist.
