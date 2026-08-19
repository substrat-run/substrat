---
status: historical
layer: plan
description: Agent-loop acceptance run 006.
---

# Agent-loop acceptance run 006 — CykelKraft, from scratch

Date: 2026-07-16 · Benchmark shape: **the from-scratch flow** — the first run conducted
**outside this monorepo**, against the published packages only, with no reference vertical
and no `CLAUDE.md` · Result: **PASS — and faster than run 001 despite having strictly less
to work with**

## Why this run is different

Runs 001–005 all measured an agent *pointed at this repo*. Run 001's own setup names what
it had: "`CLAUDE.md` conventions, the `new-vertical` skill, `tools/boundary-lint.mjs`, the
contracts/kernel/engine sources, and the ServiceCo reference (`demos/fsm`)." That is the
benchmark passing under laboratory conditions.

**A real user has none of it.** The demos are private and never published; `boundary-lint`
lived in `tools/` and rooted itself at this repo; `CLAUDE.md` and the skill were files in a
tree the user does not have. 006 is the first run to measure what a stranger actually gets.

## Setup

- **Working directory:** an empty temp dir. Reading this monorepo was **explicitly
  forbidden in the task statement** and the agent was told that doing so invalidates the
  run. Its report and output show no evidence it did.
- **Available:** the public npm registry (`@substrat-run/*` at 0.3.0, `boundary-lint`
  0.0.1), the `substrat` skill (installed at `~/.claude/skills/`, so visible from any
  directory), the public docs site.
- **Not available:** this repo, `demos/*`, `CLAUDE.md`, the `new-vertical` skill.
- **Given to the agent:** one task statement in a user's prose — a bike shop in Gothenburg,
  650 SEK/h with a one-hour minimum, mechanics must not see pricing, customers must not see
  each other, e-bike inspections need a senior mechanic's signature. **No spec, no recipe,
  no API hints, no mention of any skill.** The skill was left to trigger on its own.
- **Agent:** Claude (general-purpose), single session, **~15 min, 60 tool uses**, ~147k
  tokens.

Run 001 took **~26 min and 75 tool uses with `demos/fsm` in the tree**. 006 did more, from
less, in less. The skill did not merely replace the reference — it outperformed it.

## What came back

A complete vertical (1,461 lines): manifest + migration + 15 operations with the pricing
moment, an idempotent-ish two-tenant seed world, a thin Hono server, a 30-test scenario,
and a project `CLAUDE.md` for the next session.

Its coverage read: a repair is a **work order** (engine owns the lifecycle); time and parts
are the engine's; the e-bike inspection is `protocol`; the invoice is `invoicing`
**reached by event, never imported**; tenancy/permissions/audit are the kernel's; bikes,
customers, workshops, the price list and the one-hour-minimum rule are the vertical's.

**Verified independently after the run** (not taken from the agent's report): `pnpm test`
**30/30**, `tsc --noEmit` clean, `npx @substrat-run/boundary-lint` green with ownership
resolved from all three engines in `node_modules`. Portal listing is a per-entity proof
walk. It **stopped at both human checkpoints** and presented the migration and permission
diffs rather than self-approving.

Unprompted, it **planted three violations to check the linter was not vacuously passing**,
and confirmed R5 caught `workorder_orders` ownership. That is the exit-2 concern
(`boundary-lint`'s refusal to print a green light it has not earned) being independently
re-derived by a user in the field.

**It avoided the Zod trap** — no raw `zod` import, `zod` not a dependency, `z` taken from
`@substrat-run/contracts`. The skill's guidance held under real conditions. Note this run
happened *after* 0.3.0 shipped; the trap is now dormant rather than absent, so this tests
the guidance, not the hazard.

## Where the platform pushed back (the mechanism working)

1. **`'cykelkraft' as TenantId` compiled, then threw at runtime.** Ids must be ULIDs. The
   brand is structurally `string`, so the compile-time type is **weaker than the runtime
   schema** — which cuts against §5.6's "invalid states unrepresentable in TypeScript".
   The agent switched to real ULIDs and, correctly, did not smuggle names into them.
2. **`piiClass: 'direct'` rejected without `subjectId`** — "crypto-shredding must be able
   to key the erasure". The agent labelled the PII honestly and keyed it rather than
   downgrading the class to dodge the check. The fail-closed shape pushed toward the
   honest answer, which is the whole design.
3. **`undeclared entity relation: protocol → workorder`.** The best one.
   `instantiateProtocol` links that edge but **cannot declare it** — the engine has no idea
   the vertical's inspections hang off work orders, so the vertical must declare the
   engine's edge on its behalf. Failed loudly; the error named the fix. Same class of
   pushback as run 001's `workorder → bike`.
4. **`permission denied: protocol:create`** — the front desk could not define a template
   until granted.

## What the run found (the reason it was worth doing)

### 1. The manifest guard is unusable for conditional gates — in a realistic domain

`protocol/all-signed` is an **unconditional** gate on an operation. Only e-bikes need a
safety inspection, so wiring it to `repair/handover` would block every puncture repair
forever. The agent fell back to the engine's exported `requireSigned()`, called
conditionally inside the vertical's operation.

This is **exactly what run 005 decided** — "guards key on operations, not engine
transitions" and "conditional-on-vertical-data policy stays vertical glue". 006 is not a
contradiction; it is the first evidence of what that decision *costs* in a domain nobody
designed it around, arrived at independently by an agent that had never read the decision.

The consequence is worth stating plainly: **run 005's operation-withdrawal fix does not
apply to conditional gates.** 005 closed the bypass by withdrawing `workorder/close` so no
ungated path to `closed` remained. Here the vertical cannot withdraw its own guarded op,
and the gate lives in vertical glue — droppable by a later AI edit, which is precisely the
weakness kernel-design open question 11 raised against vertical-owned orchestration
("visible glue, but droppable by AI edits — weak for compliance-grade gates"). A
compliance-grade *conditional* gate currently has no mechanical home.

### 2. Rule 5 is a convention, not a mechanism — and the portal walk is why it is hard

`CLAUDE.md` says every operation's first line is `assertAllowed(await ctx.check(PERM))`.
**`boundary-lint` does not check this**, and the agent noticed. Its own `listOwnBikes` and
`listOwnRepairs` have no `assertAllowed` at all:

```ts
const listOwnBikes = async (ctx: OperationContext): Promise<BikeRow[]> => {
  const all = ctx.sql.query<BikeRow>('SELECT * FROM cykel_bikes ORDER BY created_at DESC');
  for (const bike of all) {
    const decision = await ctx.check(PERM.readOwnBike, bikeRef(bike.id));
    if (decision.allowed) mine.push(bike);
  }
```

That is **correct** — the prescribed portal proof walk. Which is exactly why the rule
resists the obvious lint: "first statement must be `assertAllowed`" would forbid the
pattern the platform recommends.

A tractable R6 exists: **every operation handler must reference `ctx.check` somewhere.**
The portal walk satisfies it; a forgotten check does not. It is weaker than the stated rule
(it cannot prove the check *gates* anything) but it converts the most load-bearing rule in
the platform from hope into a mechanism, and it is the rule most likely to be forgotten in
generated code. Worth taking.

### 3. `billableLine` did not anticipate aggregate pricing

`(sourceType, sourceId)` assumes a billable line traces 1:1 to a reported entry. A one-hour
**minimum** is a per-repair rule attributable to no single time entry. The agent used
`sourceType: 'time', sourceId: orderId` — it works, and it is a lie the contract permits.
Engine surfaces are frozen once shipped (D-28 is additive-only), so this is worth deciding
before more verticals encode the workaround.

### 4. Smaller friction, recorded

- `protocol/list-for-entity` takes a bare `EntityRef`; `protocol/instantiate` wraps it in
  `{ entity }`. Cost a debug cycle. Gratuitous inconsistency in a surface agents read.
- Money helpers strip trailing zeros — 650 SEK is `'650'`. Correct; will surprise anyone
  formatting.
- The agent guessed, and flagged: one scope for both workshops; the minimum applies per
  repair, not per time entry; labour bills only if time was reported; customers cannot see
  their own invoice.
- `seed()` is not idempotent, so `pnpm dev` reseeds each boot. The skill asks for
  idempotent; it did not deliver.

## The flaw in this run's design, recorded honestly

**The skill's coverage example is a bike shop, and this run's task was a bike shop.** The
same author wrote both, hours apart. The agent's coverage answer echoes the skill's worked
example nearly verbatim.

So 006 demonstrates that **the scaffold half works from scratch**. It demonstrates
**nothing** about whether the coverage step — the interview's most valuable and most
easily-flattered moment — generalizes to a domain the skill has not pre-chewed. The
honest-no path was never exercised either: a bike shop is a good fit, so nothing tested
whether the skill can say *no*.

**007 should be a domain the skill does not name** — Canopy (document management, where
the depth-4 entity walk is a real constraint) or a media pipeline (where the outbox drain
does not exist and the answer should be a partial no). A run where the correct outcome is
"don't scaffold this" is the one that would prove the honest no is real.

## Verified

Independently re-run against the agent's output, not quoted from its report:

| Gate | Result |
|---|---|
| `pnpm test` | **30/30** |
| `tsc -p tsconfig.json --noEmit` | clean |
| `npx @substrat-run/boundary-lint` | green; ownership resolved from 3 engines in `node_modules` |
| raw `zod` import / dependency | none — `z` from `@substrat-run/contracts` |
| stopped at the checkpoints | yes — both diffs presented, neither self-approved |

## Consequences

- **The from-scratch flow works.** A stranger with an empty directory, the published
  packages, and the skill reaches a working, isolation-proven vertical in ~15 minutes. That
  is milestone one's substance (plan §13.4) achieved outside the laboratory.
- **The skill outperformed the reference vertical** (15 min / 60 tools vs 26 min / 75 with
  `demos/fsm` present). Distribution of the skill is therefore worth more than distribution
  of a reference — which is an argument for the plugin, and against publishing the demos.
- **Two findings deserve their own work**: the conditional-gate hole (§1) and R6 (§2).
- **007 must change domain** to test what 006 could not.
