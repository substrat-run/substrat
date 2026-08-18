# evals/ — the generator's regression suite

builder-studio.md §9.6, D-51, issue #630. **The skills are the product**: every edit to
a skill file, every model change, every effort adjustment, every harness restructure
changes what every future vertical looks like. This directory is what makes such a
change *reviewable* instead of a leap of faith — the same move `packages/contract-tests`
makes for adapters, applied to the generator.

## What lives here

One directory per fixture, and a fixture starts at **one of two places** — which one
decides what the run measures.

**Start at the concept** (`concept.md`) — a **frozen** concept document, complete
enough that a competent build needs no questions. Frozen means frozen: editing a
concept invalidates every historical result against it; add a new fixture instead.
This measures how faithfully a fully specified design gets built.

**Start at the prompt** (`prompt.md` + `answers.md`, #740) — the brief a customer
would actually give, and everything the builder answered. The run begins in the
interview phase and writes its own `spec/concept.md`, so the interview → concept link
is inside the measurement instead of below it.

- `prompt.md` — the underspecified brief, in the customer's words. Nothing else: any
  meta-commentary here is guidance the model would not have had.
- `answers.md` — every answer as **one block**, never question-answer pairs. The
  questions vary run to run, so anything matching their wording breaks on the first
  re-run; delivered whole, the interview skill finds its frontier covered and proposes.

The replay is three turns — brief, answers, approval — and the approval message is the
harness's, deliberately saying nothing about the domain. Both modes converge on the
same build message the moment a concept exists, which is what makes their build halves
comparable.

A directory with both starting points, or neither, is an error rather than a skip: a
sweep that quietly runs fewer fixtures reads as a pass.
- `expect.json` — the expected structural outcome, checked from the *outside* (the
  gates and the probe), never fed to the model:
  - `operations` — operation names that must exist in the project's registered modules
  - `roles` — role key → permission keys the role must hold at minimum (superset is
    fine; dropping a pinned key is the regression)
  - `files` — paths that must exist
  - `maxTurns` — optional per-fixture turn ceiling

Gates-green is always required and never declared.

**What a prompt fixture does not pin yet.** `todo/` pins only files, because the
vocabulary is the model's freedom: a run that names the vertical `tasks` rather than
`todo` would fail an `operations` pin for its naming rather than for its judgment.
Scoring the assumptions themselves — every assumption mapped to a fork, measured as
*forks correct at a given question count* so that asking more questions is not itself
rewarded — is the other half of #740.

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
