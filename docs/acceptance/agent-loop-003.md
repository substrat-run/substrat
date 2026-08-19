---
status: historical
layer: plan
description: Agent-loop acceptance run 003.
---

# Agent-loop acceptance run 003 — protocols in ServiceCo (engine-protocol milestone A)

Date: 2026-07-14 · Benchmark shape: extend an existing vertical against a design doc
([engine-protocol.md](../engines/protocol.md) §2 milestone A), triggering BOTH
human checkpoints · Result: **PASS, with one convention gap surfaced**

## Setup

- Task statement: implement milestone A — protocols/checklists as ServiceCo vertical
  code (no new package), fill/sign operations, sign → immutable + append-only
  invariants, the vertical-composed completion guard, a v0 UI slice, scenario
  coverage, spec-doc updates; stop at the checkpoints.
- Agent: Claude (general-purpose), ~27 min of agent time, 40 tool uses — **across a
  host restart**: the session died mid-build and the agent was resumed from its
  transcript with a note about repo changes made meanwhile; it picked up exactly where
  it stopped. Continuity through interruption is itself a result.

## What came back

`demos/fsm/src/protocol.ts` (module code: 4 tables, 8 operations, guard predicate
`requireSigned`, replayable content hash), manifest wiring (5 permission keys, 4 fat
events, `protocol → workorder` relation, migration `0002-protocols` appended),
seeded egenkontroll-el template, 8 REST routes, an order-detail fill/sign panel, spec
updates, and scenario steps 10–13 (guard blocks → append-only fill → fill≠sign split →
sign freezes/hash replays → guard opens → template v2 vs pinned v1 → void keeps rows).

Verified independently: typecheck clean, boundary lint green, fsm 13/13, full suite
green. Live HTTP: guard 400 → fills → technician sign 403 → office sign → frozen 400 →
complete 1030 SEK.

## Where the platform pushed back

1. **Boundary lint (no `node:*` in module code) blocked `node:crypto`** — the agent
   hand-rolled FNV-1a instead. Mechanically compliant, humanly wrong: review replaced
   it with **Web Crypto SHA-256** (`crypto.subtle`, importless, identical on Node/
   Workers/browsers) and the rule "web-standard APIs always, never hand-roll a hash"
   went into CLAUDE.md. The lint did its job; the conventions had a gap the run
   exposed and closed — the feedback loop the acceptance benchmark exists to drive.
2. `domainEventInput`'s PII refinement forced `subjectId` on pseudonymous events.
3. ULIDs aren't intra-millisecond monotonic → "latest response" orders by `rowid`.

## Checkpoints (approved by Markus, 2026-07-14)

1. Migration `0002-protocols`: `serviceco_protocol_{templates,instances,responses,signatures}`.
2. Permission diff: `protocol:create|fill|sign|read|void`; fill≠sign split (technician
   fills, arbetsledare signs); no grant changes; `countersign` deferred to milestone B.

Approved judgment calls: guard rule `montage → egenkontroll-el`; template authoring
shares `protocol:create`; sign allowed on incomplete protocols (hash freezes what
exists); no unique index on signatures (leaves room for milestone-B counter-signature
rows).

## Next in the rehearsal

Milestone B: CykelService's differently-shaped checklist (per-bike condition report,
customer counter-sign at pickup) forces extraction of `engines/protocol` — the
decision-27 extraction discipline as a benchmark run.
