---
status: historical
layer: plan
description: Agent-loop acceptance run 007.
---

# Agent-loop acceptance run 007 — Canopy, a domain the skill does not name

Date: 2026-07-16 · Benchmark shape: **coverage generalization** — the first run on a domain
the `substrat` skill has no worked example for, from scratch, outside the monorepo ·
Result: **PASS — and the run's most valuable output is a kernel gap nobody had noticed**

## Why this run exists

Run 006 passed, and [its own writeup records why that proved less than it looked](agent-loop-006.md):
the skill's coverage example is a bike shop and 006's task was a bike shop, written by the
same author hours apart. 006 demonstrated the **scaffold** works from scratch. It said
nothing about whether **coverage** — the interview's most valuable and most easily-flattered
moment — generalizes to a domain nobody pre-chewed.

007 is that test. Canopy is a Drive alternative for law firms: deep folder nesting,
partners/associates/clients, documents in S3, and a knowledge graph. The skill names none
of it.

## Setup

- **Working directory:** an empty temp dir. Reading this monorepo was explicitly forbidden.
- **Available:** the public npm registry (0.3.0), the `substrat` skill (`~/.claude/skills/`),
  the public docs site, and `node_modules` once installed.
- **Given:** one task statement in a customer's prose. The traps were buried, not flagged —
  "it nests the way you'd expect… it gets deep" and "we let the firm's own clients log in to
  see the documents on their own matter — and absolutely nothing else, ever."
- **Agent:** Claude (general-purpose), single session, **~25 min, 82 tool uses**, ~160k tokens.

## What came back

A zero-engine vertical (1,734 lines): 11 operations, 26 tests, a live server driven with
curl through seven attacks.

**Coverage generalized.** Unprompted, it reported "Canopy uses zero engines… there's no work
order, no inspection, no money. The engines are irrelevant to you. What you get is Tier 0 —
and it happens to be *exactly* the part you said is the entire product." That is the correct
answer, reached without a worked example, on a domain the skill never mentions. It also
refused the knowledge graph (§4 below).

**The permission design is the result worth reading.** Partner → node-level role, sees the
firm. Associate → `canopy:browse` and nothing else at node level; every data permission is
an entity-narrowed grant on a *matter folder*, carried by the kernel's walk. Client → a grant
held by their **org**, narrowed to one matter, **plus** a per-document share flag; both
required. Partner and associate run **the same check on the same code path** — there is no
`if (isPartner)` in the module. That is D-23's model doing exactly what it was designed for,
discovered rather than instructed.

**Verified independently** (re-run, not quoted): `pnpm test` 26/26, `tsc --noEmit` clean,
`boundary-lint` green. It injected three violations to confirm the linter was not vacuously
passing. Live denials landed, including a client refused the internal memo **on their own
matter**, and a client following a graph edge to it getting `200 []`.

## The finding: entity parent edges are permanent (→ open question 15)

007 asked a filing product's most basic question — *can I move a document to the right
matter?* — and traced the answer through the source:

- `OperationContext` exposes `link(child, parent)`. **There is no `unlink`**, anywhere in the
  kernel or either adapter.
- Links are `INSERT OR IGNORE` into `_substrat_tuples`; module code may not write `_substrat_*`
  (R4), so there is no vertical-layer workaround.
- The checker expands **every** `relation = 'parent'` tuple at each frontier. Linking a new
  parent **adds** a path; it does not replace one.

So a "moved" entity stays reachable from where it used to be, permanently, with no remedy at
any layer. **This is not a Canopy quirk.** Every declared edge in the tree has a routine
business event that breaks it — `bike → customer` when a bike is sold, `order → customer`
when a customer is acquired, and `facility → customer` when a building changes management
company, which is routine in property management and PropCo is the anchor case. No demo
caught it because no demo ever moves an entity.

Recorded as **kernel-design open question 15** with the design space, because the trade is
real: tuple deletion is simple and destroys the audit property K-4 rests on.

## What else it found

### 1. The depth ceiling is 3 folders, undocumented, and fails silently

`ENTITY_WALK_DEPTH = 4` is hard-coded in the adapter. The loop checks the frontier *then*
expands, so an ancestor at depth 5 is never checked — **at most 3 folder levels between a
matter and a document**. The task's canonical `client/matter/year/doctype` has exactly one
level to spare.

The agent's own test caught its off-by-one: it reasoned the budget allowed 4 intermediate
folders, and `a document at the maximum legal depth is STILL visible to the staffed
associate` failed with `document not found`. Its trace:

```
depth 4: check [deep-a]  expand → matter
loop ends (5 > 4) → THE MATTER FOLDER IS NEVER CHECKED
```

It **fails closed and silently** — files vanish for associates and clients with no error
anywhere. The agent made `folder-create` refuse the 4th level with a loud error instead,
which is the right move and one the platform should arguably make itself.

Its verdict is the part to sit with: *"the single most important constraint on this product
is discoverable only by reading the implementation."* Not in the manifest, not configurable,
not on the docs site. For a product whose pitch is "it nests the way you'd expect," that is a
front-page fact.

Related and pinned by its test: **client-level staffing is not expressible.** "Marcus handles
all Northwind work" needs a grant on the client folder — 5 edges from a document in the
deepest legal folder. The *same grant* reaches at 4 edges and not at 5. Grants must be
per-matter, forever.

### 2. Listings are O(n) proof walks with no pagination story

`matter-list` checks every matter individually — correct, that is the proof walk — but a firm
with 5,000 matters does 5,000 SQL walks per page load, and there is no pagination design that
preserves the proof. Couples with K-19 (reads get fast by getting short).

### 3. It refused the knowledge graph, with better reasoning than the brief deserved

> "Doing it properly means an external index that must **re-implement the permission walk** —
> and the moment your index answers a query the kernel didn't authorize, you have exactly the
> leak that ends the company. Keep the graph out of the kernel, build it as a connector fed by
> the fat events, and have it call back for authorization per hit rather than storing its own
> ACLs. Do not let it become a second source of truth about who can see what."

That is the honest no landing on a sub-part of a product that is otherwise a good fit — the
harder version of the test, and it passed.

### 4. It found its own security bug by running the thing

Driving the live server, it noticed a client could fetch the **entire version history** of a
shared document — so a firm redacting at v3 and sharing would leak v1's storage key. Fatal in
a confidentiality product. It added `shared_from_version` and a redaction test. Caught by
curl, **not** by a test — which is the skill's "actually exercise it, don't just report that
the server started" instruction earning its place.

## Friction (confirmed independently by run 008 where noted)

- **`boundary-lint` refused a zero-engine vertical** (exit 2). Its workaround: point
  `externals` at `@substrat-run/contracts`, a module owning zero tables, "purely to pass the
  gate" — and its verdict: *"the workaround is indistinguishable from gaming the linter."*
  **Also found by 008.** Fixed.
- **`kernelContract: '^0.0.1'` is never validated at runtime.** Grepped and confirmed by the
  agent. Inert field with a misleading value while packages are 0.3.0. **Also found by 008.**
- **The docs site is thin on exactly the topics Substrat exists for** — nothing on
  permissions, entity-narrowed grants, portal access, or `entityRelations`. It worked "almost
  entirely from `.d.ts` files" and noted the types are excellent while the website is not.
  **Also found by 008.**
- **`attachmentTargets`, `searchables`, `ui` are consumed by nothing** in the sqlite adapter.
  Declared; inert. Unclear whether aspirational or Cloudflare-only.
- **Every id must be a ULID**, including the platform actor — the rationale is sound but the
  skill's example implies readable tenant ids. It wrote a `fixedId()` helper. **Also found by
  006 and 008**: three independent runs, same friction.
- **`piiClass` forced a GDPR decision it had dodged** — "who is the data subject of a legal
  document?" It keyed on the client org and documented two compromises rather than hiding
  them: a company is not a GDPR data subject, and the envelope holds one subject while the
  events concern two people.

## Verified

| Gate | Result |
|---|---|
| `pnpm test` | 26/26 |
| `tsc --noEmit` | clean |
| `boundary-lint` | green (after its workaround; the underlying bug is now fixed) |
| linter checked to be non-vacuous | yes — three violations injected and caught |
| stopped at the checkpoints | yes — both diffs presented, neither self-approved |

## Consequences

- **Coverage generalizes.** The skill's most valuable moment worked on a domain it does not
  name, and produced the correct zero-engine answer plus a partial no on the graph.
- **Open question 15 is the run's real output**, and it is time-sensitive: retrofitting edge
  revocation after PropCo accumulates a year of links means auditing every grant that ever
  resolved through them.
- **The depth ceiling needs documenting and probably enforcing.** A constraint that fails
  closed and silently, discoverable only in `checker.js`, is the shape of a bug that ships.
- **Three runs now agree** on the ULID friction, the inert `kernelContract`, and the thin docs
  site. Convergence from independent agents is the strongest signal this methodology produces.
