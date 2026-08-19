---
id: D-57
date: 2026-08-19
layer: plan
title: "The agent-loop acceptance benchmark is retired; the run records are kept"
status: accepted
aliases: []
amends: [D-2]
tracking: []
---

# D-57 — The agent-loop acceptance benchmark is retired; the run records are kept

**The standing obligation goes; the evidence stays.** §5.6 called "can an agent build a
vertical unaided up to the checkpoints?" **the recurring benchmark** and "the question every
kernel API review should end with", and kernel-design §11 listed it as testing-strategy item
4. Eight runs exist, all between 2026-07-14 and 2026-07-16, and none since — across a period
in which the platform gained three engines, the builder studio, the model phase,
sub-transactions and a live production tenant. A claimed discipline that has not run in five
weeks is worse than an absent one, because it is read as coverage. So the claim comes down
from §5.6 and from kernel-design §11. **The eight records in `docs/acceptance/` stay, at
`status: historical`** — they are load-bearing evidence, not ceremony: kernel open question
15 (entity re-parenting, an unresolved access-revocation failure) cites run 007 as where it
was found, `packages/boundary-lint` ships a test suite named `zero-engine verticals
(agent-loop-008)`, the root README credits run 001 with the Handlebar demo's existence, and
`rfc/booking-social.md` cites 007. Deleting them would orphan a live open question's
provenance and a shipped test's rationale.

## Why

**`apps/builder/evals` is not a replacement, and this entry declines to pretend it is.**
Evals sweeps frozen concept fixtures through the studio's generator before and after any
skill, model or harness change — a regression test on *our* generator. The retired benchmark
asked a different question: whether an **arbitrary** agent, working **outside this
monorepo**, against the **published packages only**, on a domain the skill has no worked
example for, reaches a checkpoint-clean vertical. Runs 006, 007 and 008 were explicitly that
shape, and run 008's value was that the correct answer was partly *"this does not belong
here"*. Nothing now covers it. Naming that loss is the point of writing this down rather
than letting the practice lapse by drift — the same failure D-8 was re-ratified to avoid.

What made the benchmark expensive is also what made it good: each run was a hand-conducted
exercise with a written verdict, which is not a thing CI can hold. The honest position is
that the platform now leans on mechanical gates (`lint:permissions`, `lint:model`,
`lint:api`, `lint:decisions`, boundary-lint, migration replay, the contract tests on both
adapters) plus evals for the generator, and has **no standing test of the unaided-agent
claim**. If that claim re-enters a pitch, this entry is the reason to run 009 first.
