---
status: historical
layer: plan
description: Agent-loop acceptance run 005.
---

# Agent-loop acceptance run 005 — the manifest guard (engine-protocol milestone C)

> **Retired as a practice (D-57), kept as evidence.** There is no standing
> obligation to run more of these. This record stands because later work cites it.

Date: 2026-07-14 · Benchmark shape: **kernel-surface change** — the first run to add
permanent contract surface, resolving kernel-design open question 11 · Result: **PASS,
and the run's most valuable output was a bug it found in its own design**

## Setup

- Task statement: implement §6's manifest-declared guard. Sub-questions pre-resolved by
  review before the run: guards key on **operations, not engine transitions** (the kernel
  must never learn engine internals), and manifest guards are **unconditional gates** —
  conditional-on-vertical-data policy stays vertical glue.
- Agent: Claude (general-purpose), two passes (~16 min + ~6 min), 75 tool uses.

## The surface (pinned)

Three additive pieces — no new tables, permissions, or event types:

1. **`guards`** (manifest, optional): `{ before: <operation>, predicate: <name>, config: {} }`.
2. **`predicates`** (`ModuleRegistration`, optional): `GuardPredicate = (ctx, config, input) => void | Promise<void>` — throws to block, returns to allow. One module *contributes* a predicate; another module's manifest *wires* it. The protocol engine contributes `protocol/all-signed`; the vertical declares the gate.
3. **`withdraws`** (manifest, optional): operation names whose engine **default binding** this module suppresses in its host.

Guards fire inside the operation's own transaction, immediately before the handler; a
guard throw rolls back exactly like a handler throw. Predicates resolve **at invoke, not
at registration** — registration order is caller-controlled, so an unresolvable predicate
*blocks* the operation rather than rejecting valid-but-early wiring. A typo can only close
a gate, never widen one.

## What the run found (the reason it was worth doing)

Version 1 passed every gate and was **quietly bypassable**. A manifest guard binds the
operation it names; the engine's `workorder/close` stayed registered beside the guarded
`bike-shop/close-repair`, and the workshop admin holds `workorder:close`. Verified with an
independent probe against the real seeded world:

```
GUARDED  bike-shop/close-repair : blocked — 'tillstandsrapport' must be counter-signed
BYPASS   workorder/close        : CLOSED, status='closed'   <-- the hole
```

The agent surfaced this honestly in its own report rather than declaring victory, and its
verdict — "worth pinning only if you also intend to close the default-binding hole" — was
the actual decision input. **Operation withdrawal** closes it: order-independent, opt-in,
and it removes the *binding*, not the capability (the engine's in-scope `closeWorkOrder`
stays composable — it is exactly what the vertical's guarded op calls). Same probe, after:

```
GUARDED  bike-shop/close-repair : blocked — must be counter-signed
BYPASS   workorder/close        : blocked — unknown operation: workorder/close
```

There is now no ungated path to `closed` in CykelService's host. The guard sits *in front
of* the engine, not instead of it: a counter-signed repair still cannot skip
`planned → closed` — the state machine refuses.

## Verified

`pnpm -r build`, `pnpm -r typecheck` (0 errors), `node tools/boundary-lint.mjs`, full
`pnpm test`: adapter-sqlite contract **29/29** (6 new: 4 guard + 2 withdrawal — every
future adapter must now implement both), demos/fsm **13/13** (withdraws nothing — the
demonstration that withdrawal is opt-in), demos/bike-shop **13/13**.

## Open question 11 — resolution (ratified by Markus, 2026-07-14)

**Both poles, each carrying the case it fits.** Unconditional compliance gates →
manifest-declared guard + withdrawal (CykelService: a bike cannot be handed back without
the customer's counter-signature). Conditional-on-vertical-data policy → vertical-composed
glue (ServiceCo: only `montage` orders require an egenkontroll — `order.kind` is vertical
vocabulary the kernel must never learn). The manifest half is what a reviewer can
enumerate: every compliance gate in the system is readable from the manifests without
opening a single operation body, and *dropping* a gate is a manifest diff, not a deleted
line buried in a handler.

Review question #4 resolved (operations, not transitions: the kernel would have to learn
engine internals, there is no legitimate interception point, and it is the wrong unit of
review). Review question #5 (the default-binding hole) resolved by withdrawal.

## Note for the decision log

The master plan's OQ11 entry is Markus's to write; this run is the evidence behind it.
