---
status: historical
layer: plan
description: Agent-loop acceptance run 008.
---

# Agent-loop acceptance run 008 — PodHost, and the honest no

Date: 2026-07-16 · Benchmark shape: **the honest no** — the first run where the correct
answer is partly "this does not belong here" · Result: **PASS — it refused three things,
named replacements, and found a contradiction in our own tooling**

## Why this run exists

[Run 006](agent-loop-006.md) passed on a bike shop, which is a good fit, so nothing tested
whether the skill can say **no**. The skill instructs it to: *"Substrat is the wrong tool for
plenty. Say so — it is what makes the yes trustworthy… If it's a bad fit, say so, say why,
name a better tool, and stop."* Untested, that paragraph is decoration.

A podcast platform is the sharp version of the test, because it is **partly** a fit. The bait
is real: an encoding pipeline is steps with states, and a flattering agent reaches for
`engine-workorder`. The correct answer splits — publisher back-office and workflow state are
Tier 0's job; RSS delivery, transcoding, and download-time entitlement checks are not.

## Setup

- **Working directory:** an empty temp dir. Reading this monorepo was explicitly forbidden.
- **Available:** the public npm registry (0.3.0), the `substrat` skill, the public docs site.
- **Given:** one task statement in a customer's prose, traps buried rather than flagged —
  *"each of those steps takes a while and any of them can fail — we need to retry the bits
  that broke"* (a workflow engine's job description), *"a few million downloads a month"*
  (wrong physics), and *"the transcripts have people's names and all sorts in them"* (a
  genuine yes).
- **Agent:** Claude (general-purpose), single session, **~16 min, 57 tool uses**, ~146k tokens.

## The honest no landed

Unprompted, it refused three things and named replacements:

- **Serving the feed and the audio.** *"Substrat must never be in the download path — one DO
  hop per download is the wrong shape and the wrong bill."* CDN + object storage.
- **Transcoding and STT** — and its reasoning is better than the one in our own docs: *"an
  operation holds the scope's transaction and serializes the whole show, so a 40-minute
  transcode blocks every other operation on that show for 40 minutes."* It then observed the
  constraint **improved the design**, because being unable to `fetch` forced claim/complete/fail,
  which is what makes per-step retry work. Queue + workers.
- **Premium entitlement checks at download.** Substrat should *issue* signed tokens; the edge
  validates them. A scope invoke per download is a non-starter.

Its summary: *"Substrat's real job here is the state, the permissions, the tenancy, and the
audit trail — which is precisely the part you'd otherwise build badly. Uploading, transcoding,
and serving are somebody else's."*

**It also refused `engine-workorder`**, which is the bait working as intended: *"an episode
pipeline is three independently-retryable async machine steps with no human, no hours, no
money, and retry means **re-entering** a state — which that machine cannot express. Forcing it
would be a fork, and a fork means the engine drew its line wrong."* That is rule 7 reached by
an agent that never read rule 7's rationale.

## What came back

A zero-engine vertical (1,665 lines): 16 operations, a pipeline state machine, 23 tests, and —
unprompted — `src/worker.ts`, a **separate connector process** for transcode/STT, because
module code cannot `fetch`.

`episode.status` is **derived from its steps, never settable**, which is what makes "know
exactly what state every episode is in" true rather than aspirational. `retry-step` moves
`failed → pending, attempt+1` and re-runs only the broken step.

**Verified independently** (re-run, not quoted): 23/23 tests, clean typecheck, zero engine
imports in module code, `z` from contracts. Full curl drive with `FAIL_ONCE=transcribe`:
upload → premature publish refused → worker fails → `blocked` → retry → `ready` → publish →
feed. Cross-tenant attacker denied both ways (403 with the right pair, `unknown scope` with
the wrong one).

**Erasure verified against disk, not the API:** after `erase-transcript`, the ciphertext row
remains, the key row is gone, and the names appear in neither the `.sqlite`, the `-wal`, nor
the `-shm`.

## The finding: our tooling contradicted itself

> *"`boundary-lint` cannot pass a zero-engine vertical — a real contradiction. The skill
> explicitly blesses zero-engine verticals (`demos/shop` … a normal, supported outcome), **and**
> tells me never to wave through exit 2. Those two instructions are unsatisfiable together."*

Correct, and both artifacts were written by the same author hours apart. The guard was
`owners.length === 0 && linted.length === 1`; the monorepo lints six packages so it never
fired, and `demos/shop` appears to pass only because engines are linted beside it. **The
monorepo hid it**, exactly as it hid every other from-scratch bug this week.

Its workaround — engines as `devDependencies` — was defensible (R5 then genuinely proves the
vertical never touches `workorder_*`) but it is a workaround. [Run 007 hit the same wall
independently](agent-loop-007.md) and took a different one, calling it "indistinguishable from
gaming the linter." Fixed: the guard now compares **declared** against **resolved**.

## What else it found

### 1. The GDPR ceiling, stated plainly

> *"I can shred a whole episode's transcript. I **cannot** do 'erase Jens Palmgren from
> everywhere' — the kernel's one-subject-per-event model doesn't reach it, and neither does my
> per-episode key. That's a real Article 17 scenario for a publisher. **Don't promise it.**"*

The spine keys erasure on one `subjectId` per event; a transcript names dozens of people.
This is worth hearing before it reaches a sales deck. §5.3's crypto-shredding story is real
and it is narrower than "GDPR handled".

### 2. `drained_at` is dead, and a vertical is already depending on that

Its audit timeline assumes the outbox is append-only — *true today only by accident of nothing
implementing drain*. Its words: **"this should be a documented guarantee, not an accident."**
If drain ever lands, its timeline silently loses history. Couples with kernel-design open
question 3 (drain semantics, per-sink watermarks).

### 3. It caught its own false green

> *"My own curl was wrong once — I hand-typed a ULID with one zero too many and got a 404 that
> **looked** like an isolation proof. It wasn't. I re-ran with real ids; the genuine result is a
> 403."*

Flagged unprompted, "because it's exactly the false-green a report would otherwise claim." An
acceptance methodology is only worth what its reports are worth; this is the behaviour that
makes them worth something.

### 4. Smaller friction

- **Bin name mismatch:** the skill says `npx @substrat-run/boundary-lint` (which works, npx
  resolves the package) but the actual bin is `substrat-boundary-lint`, which is what a
  `package.json` script needs. Minor, confusing, cheap to document.
- **`kernelContract: '^0.0.1'`** while packages are 0.3.0. **Also found by 007**, which grepped
  it and confirmed it is never validated at runtime.
- **All ids must be ULIDs**; it wrote a `devId()` helper folding `I/L/O/U`. **Also found by 006
  and 007.**
- **`_substrat_events` does not exist** — it is `_substrat_outbox`. It checked the adapter
  rather than guessing; a guess would have failed at runtime.
- **`actor` is JSON-encoded** in the outbox, so a bare comparison gives `'"ULID"' !== 'ULID'`.
- **TS rejected its Web Crypto code**: `Uint8Array<ArrayBufferLike>` is not `BufferSource`.

## Verified

| Gate | Result |
|---|---|
| `pnpm test` | 23/23 |
| `tsc --noEmit` | clean |
| engine imports in module code | 0 — deliberate, and argued |
| raw `zod` import | none — `z` from contracts |
| erasure | verified against the `.sqlite`, `-wal` and `-shm` on disk |
| stopped at the checkpoints | yes — both diffs presented, neither self-approved |

## Consequences

- **The honest no is real, not decoration.** It refused three sub-parts of a product it
  otherwise liked, named replacements, and declined an engine on architectural grounds. That
  is what makes the yes worth something — and it is the answer to the open worry in
  [generated-verticals](../strategy/generated-verticals.md) §6.1 about a channel that only ever
  flatters.
- **Two runs independently found the same tooling contradiction.** Convergence is the
  strongest signal this methodology produces, and it fixed a bug that shipped that morning.
- **The GDPR ceiling and the `drained_at` accident both need documenting**, because a vertical
  is already relying on the second one.
- **Rule 3 (no network in module code) improved a design.** Worth noting for the constraint's
  own sake: the agent said so unprompted, having been forced into claim/complete/fail.
