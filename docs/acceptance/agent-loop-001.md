---
status: historical
layer: plan
description: Agent-loop acceptance run 001.
---

# Agent-loop acceptance run 001 — CykelService

Date: 2026-07-14 · Benchmark: master plan §5.6 / demo concept §9 ("an agent, pointed at
the repo, scaffolds CykelService to the checkpoints without human prompting beyond the
task statement") · Result: **PASS, with notes**

## Setup

- Given to the agent: one task statement — *build the CykelService vertical, the v2
  bike-shop skin from demos/fsm/spec/concept.md §2, as demos/cykel; follow repo
  conventions; stop at the two human checkpoints.* No recipe, no API hints. (The
  package was renamed to `demos/bike-shop` the same day, after the run.)
- Available in the repo: `CLAUDE.md` conventions, the `new-vertical` skill,
  `tools/boundary-lint.mjs` in CI, the contracts/kernel/engine sources, and the
  ServiceCo reference (`demos/fsm`).
- Agent: Claude (general-purpose), single session, ~26 min, 75 tool uses.

## What came back

Complete vertical at `demos/bike-shop`: spec, manifest + migration + nine `bike-shop/*`
operations (pricing moment and portal proof-walk included), idempotent two-tenant seed
world, thin Hono server (:8788), nine-step scenario test with denial assertions, and a
copy-and-own React skin (:5174) — coexisting with the ServiceCo demo.

Verified independently after the run: `pnpm -r build`, `pnpm -r typecheck`,
`node tools/boundary-lint.mjs`, full `pnpm test` (adapter contract tests 23/23,
fsm 9/9, cykel 9/9) — all green. Module code: every operation starts with
`assertAllowed(await ctx.check(…))`, no `UNSAFE_allowAllChecker`, portal listing is a
per-entity proof walk, relations `bike → customer` and `workorder → bike` declared and
linked. The agent also ran a live HTTP smoke test (create → assign → start → report →
complete = 336.50 SEK with the min-billing branch exercised; wrong-role 403; portal
isolation; cross-tenant attacker denied).

## Where the platform pushed back (the mechanism working)

1. `ctx.link` manifest validation forced the agent to *declare* the permission-walk
   edges (`workorder → bike`) rather than hope: the adapter rejects undeclared links,
   and the engine links `workorder → <facility ref>` verbatim. Caught by reading, but
   would have failed loud at runtime — enforcement, not convention.
2. Boundary lint, typecheck, and the scenario suite otherwise passed first try — the
   reference plus conventions were sufficient; no prompting was needed.

One environment snag, unrelated to the benchmark: `apps/docs/node_modules/vue` was a
dangling absolute symlink into the pre-rename `chassis` checkout; the agent removed it
and the build healed. (Symptom of the repo move, now resolved.)

## What the agent had to guess → conventions updated

The run's guess list (permission-key reuse across verticals, role naming, port/
localStorage allocation for side-by-side demos) was folded back into
`.claude/skills/new-vertical/SKILL.md` after the run. Guesses were all reasonable —
none violated an invariant.

## Checkpoints

The run stopped, as required, at the two human checkpoints — migration diff (three
`bike_shop_*` tables, version `0001-init`) and permission diff (`customer:manage`,
`bike:manage`; roles `workshop-admin`, `mechanic`; two entity-narrowed portal grants;
one cross-tenant attacker holding nothing). `demos/bike-shop` stays uncommitted until a
human approves both.

## Verdict against §9

- Scaffolds to the checkpoints without prompting beyond the task statement: **yes**
- All contract tests green on the pure adapter: **yes**
- Attack vectors fail: **yes** (scenario assertions: forged tenant/scope pair →
  `unknown scope`; no tuples → `permission denied`; portal isolation exact)
- Not yet demonstrated: the staged live-attack script and view-as/explain beats of the
  15-minute demo (§7 of the concept) — separate work items, not vertical scaffolding.
