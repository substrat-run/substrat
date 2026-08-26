---
'@substrat-run/contracts': minor
'@substrat-run/engine-invites': minor
'@substrat-run/engine-metering': minor
'@substrat-run/contract-tests': patch
---

The last three packages declare their operation surface, so no entity-check claim is a grep

#865 asked for the entity-check conformance kit to reach fourteen packages, and #891 split
out the half where the recipe did not apply: a package with no declared operation registry
has nothing to convert. #891 closed five of them. These are the last three.

`engines/invites`, `engines/metering` and `demos/manyfold` each gain a declared operation
surface (`src/operations.ts`, plus an entity registry for metering and a `schemas.ts` for
manyfold), and their node-only assessment moves from `nodeOnlySuite` to
`declaredNodeOnlySuite`. The difference is what the claim is made OF:

- **Before:** a tripwire over the module's own source — no two-argument `ctx.check(perm,
  ref)` appears in it. Lexical. It proves an absence rather than a behaviour, and a check
  assembled through a helper or across lines is invisible to it.
- **After:** `planEntityCheckCoverage` reads the declaration the same way the conformance
  kit does, and the claim is that the plan is empty. Exact. It goes red when an operation
  DECLARES a narrowed check, not when someone happens to spell one on one line.

Each also gains the assertion that is easy to leave out — every operation still says what
it checks, because an ungated operation produces an empty plan too. `invites/accept` is
the one operation in the three that genuinely checks nothing (the invitation itself is the
authority) and it now declares `narrows` with the reason, so the exception is written down
rather than indistinguishable from an oversight.

That exception needed one new word to state. `narrows.checks: []` already meant "no key of
MINE is walked", which is also true of a walk over a composed engine's key — Callout's
portal walk checks `workorder:read`, and a vertical restating another module's permissions
is the defect the empty list exists to avoid. So a genuinely ungated operation adds
`narrows.unchecked: true`, and the conformance receipt counts it on its own row instead of
reporting "1 per-entity proof walk" under a header counting zero narrowed checks.

Two consequences beyond the assessment: the host now parses these operations' inputs at
the door (#893) from the same schemas the handlers already parsed, and a vertical
composing invites or metering can declare an operation returning their shapes without
transcribing them.

`nodeOnlySuite` stays exported for a module that has not declared yet — a vertical
mid-build, a module outside this workspace — with its header corrected: no package in this
repo needs it any more.
