---
status: historical
layer: plan
description: Agent-loop acceptance run 004.
---

# Agent-loop acceptance run 004 — the extraction (engine-protocol milestone B)

> **Retired as a practice (D-57), kept as evidence.** There is no standing
> obligation to run more of these. This record stands because later work cites it.

Date: 2026-07-14 · Benchmark shape: **extraction** — the decision-27 discipline as a
run: a second vertical's differently-shaped need forces protocol machinery out of
ServiceCo vertical code into `engines/protocol` · Result: **PASS** — and the primary
deliverable is the extraction-cost evidence below

## Setup

- Task statement: implement milestone B of engine-protocol.md — CykelService needs a
  per-bike condition report with customer counter-sign at pickup; extract the engine,
  keep template content in each vertical, keep ServiceCo's scenario green, handle the
  shipped-migration transition honestly, stop at the checkpoints.
- Agent: Claude (general-purpose), ~51 min, 110 tool uses; survived one transient API
  drop at start (resumed from transcript). Notably: decision 28 (engine compatibility
  surface + boundary-lint R5) landed in the repo **while the agent worked** — it
  detected the new rule mid-task and complied with it.

## What came back

`engines/protocol` (AGPL, engine norms): invariants incl. countersign (second
signature row, written only after the frozen content's hash replays identically),
in-scope functions + thin `protocol/*` bindings. ServiceCo: `protocol.ts` deleted,
content + policy stay, UI untouched, 13/13. CykelService: tillståndsrapport flow —
mechanic fills, verkstadschef signs, customer counter-signs from the portal via an
entity-narrowed grant resolving `protocol → workorder → bike → customer`; 11/11 incl.
premature/duplicate/wrong-customer/admin countersign denials.

Verified independently after the run: boundary lint (incl. R5), both scenarios, full
suite (23+13+11), typecheck — all green.

## The migration transition (checkpoint 1's hard part)

ServiceCo's shipped `0002-protocols` stayed byte-identical; new `0003-protocols-to-engine`
copies the legacy tables into the engine's (ids/hashes/timestamps verbatim, `kind`
backfilled `'primary'`) and drops them — the one sanctioned cross-module SQL, inside
the `boundary-lint-allow R5` block. Consequences ratified with the checkpoint:
engine-before-vertical registration order (fails closed if wrong); fresh scopes replay
history (0002 creates, 0003 drops). Verified against real milestone-A dev data, where
it correctly refused to rewrite evidence (an interim-build 16-char hash stayed as
written — signatures are evidence, not data to fix).

## Platform pushback

1. Extraction surfaced a real latent bug: timeline projections ordered by ULID invert
   same-millisecond events (kernel ULIDs are non-monotonic intra-ms). Fixed with
   `ORDER BY rowid` in both verticals. Kernel consumer dispatch has the same pattern —
   flagged for later.
2. R5 arrived mid-task and banned exactly the migration's cross-module copy; the
   explicit allow-pragma made the exception reviewable rather than invisible.
3. R2 pushed the engine to `globalThis.crypto`/`TextEncoder` with local ambient
   declarations (the `kernel/ulid.ts` technique) — the web-crypto rule from run 003,
   now followed without prompting.

## Checkpoints (approved by Markus, 2026-07-14)

Migrations: engine `0001-init` (+`kind` column) and ServiceCo `0003-protocols-to-engine`
as above. Permissions: the six `protocol:*` keys move to the engine's manifest; new
`protocol:countersign` sits in **no role** in either demo — portal customers only,
entity-narrowed. Ratified judgment calls: explicit `kind` column; one countersign per
principal, primary signer excluded; drop-after-copy for legacy tables; ServiceCo uses
`protocol/*` operation names directly for policy-free calls; CykelService close NOT
gated on countersign (that is milestone C's question, left unpolluted).

## Decision-27 evidence (what the rehearsal was for)

~70% of the extraction was mechanical (table renames, manifest split, in-scope/binding
pairs, import renames) — milestone A's discipline made the seam real. The ~30%
judgment concentrated in exactly three places: the migration transition (the only part
a reviewer must genuinely think about), splitting engine mechanics from vertical
policy in instantiation, and the countersign permission model (which the fixed tuple
algebra handled with zero kernel changes). Verdict: deferring extraction cost one
migration version and an afternoon; the bill is concentrated and reviewable, not
diffuse. Decision 27's discipline holds at rehearsal scale.

## Next

Milestone C: the manifest-declared guard (open question 11) — whether "complete
requires signed protocol" moves from vertical-composed glue into reviewable manifest
surface, decided with two live verticals as material.
