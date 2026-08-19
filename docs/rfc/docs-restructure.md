---
status: building
layer: plan
description: Audit of docs/ and the restructure. Phases 0-3 done; Phase 4 is the gate and the content debt.
---

# Restructuring `docs/` — an audit first, a folder tree second

**Status: phases 0–3 executed (2026-08-19); Phase 4 outstanding.** Written after reading
all 55 markdown files in `docs/`, both decision logs end to end, and verifying every status
claim against the repository. The folder tree is the smallest part of this document and one
of the last sections, deliberately: **the corpus's problem was not that the files were in
the wrong directories — it was that a third of them asserted things about the system that
were no longer true, and nothing in the repo could notice.**

§2 and §3 are written in the present tense of the audit — they record what was found, and
are left as found so the reasoning stays legible. What has since changed is marked in the
sequencing (§9). Sections describing the old `design/` and `proposals/` directories are
history, not stale text.

---

## 1. What was read, and how claims were checked

| Corpus | Size | Gated today |
|---|---|---|
| `docs/` — internal working set | 55 `.md`, ~14,000 lines; 40 files in `docs/design/` | nothing |
| `apps/docs/` — published to substrat.net | 89 pages, taxonomy `guide/ concepts/ engines/ platform/ reference/ verticals/` | `pnpm lint:docs` ([tools/docs-drift.mjs](../../tools/docs-drift.mjs)) |
| The decision logs | 83 entries — D-1…D-46 (master plan §12), K-1…K-37 (kernel design §14) | nothing |
| Acceptance runs | 8, all dated 2026-07-14…07-16 | nothing |

Every status claim below was checked by asking the repository whether the thing exists —
not by reading the document's own account of itself.

---

## 2. What is wrong

### F1 — The status field is write-once. 18 of 18 checked docs under-report themselves.

Every design doc but one carries a status line. That is a good instinct and it is the
reason this audit was possible at all. But the field is set when the document is authored
and **nothing sets it again**, so it records an intention, not a state.

Eighteen documents were checked against the repo. Every one describes something that now
exists:

| Document says | Repo has |
|---|---|
| `dashboard.md` — "**design. Not built.**" | `apps/dashboard`, first commit the same day the doc landed, a month of commits since |
| `orchestration.md` — "**Not built.**" | `substrat push/promote/preview/versions/installs`, dispatch namespaces in router + control plane + egress |
| `cms-content.md` — "For review **before any code**" | `demos/manyfold`, deployed, with `model.json` and `openapi.json` |
| `connections.md` — "For review **before any code**" | `connectors/scrive`, live against a real API |
| `engine-{booking,absence,metering}.md` — "draft v0.1" | `engines/{booking,absence,metering}`, live on npm at 0.3.1/0.3.1/0.2.1 |
| `scheduler.md` — "sketch" | sweep running in `apps/control-plane` |
| `api-surface.md`, `observability.md`, `agent-surface.md`, `marketplace-publish.md`, `vertical-auth-detach.md`, `multi-scope-manyfold.md` — "proposed" | `tools/api-diff.mts`, console metrics, `tools/agent-rules-emit.mts`, `cli/listing.ts`, `packages/vertical-auth`, `cli/installs.ts` |
| `model-phase-plan.md` — "draft for review" | `packages/model-emit` |
| `builder-studio.md` — "internal PoC first" | `apps/builder` with `evals/`, teams, entitlement gating |

The consequence is not cosmetic. [dashboard.md](../architecture/dashboard.md) is the
**most-referenced design doc in the codebase** — nine inbound links from source, tests,
`package.json` files and the published site — and it opens by telling the reader the
Dashboard does not exist.

This is a missing feedback edge, not a labelling problem. No amount of better vocabulary
fixes it; only a write-back trigger does (§8).

### F2 — The decision log is not canonical. A shadow log exists, and it has a collision.

The master plan calls itself canonical and its log ends at **D-46**. Design documents
contain a further set of decisions that were **built and never written back**:

- [permission-registry-enforcement.md](../architecture/permission-registry-enforcement.md) is
  marked "**built**", and its §7 proposes decision-log entry **41**. But master-plan
  **D-41 is already taken** — "a hosted vertical reads its entitlements at request time
  from a scope-local projection" (#304, 2026-07-28). The permission-registry decision
  appears nowhere in the master plan: `definePermissions` and "TypeScript-derived" return
  **zero hits** in `master-plan.md`. So a shipped decision holds a number belonging to a
  different shipped decision, and neither the collision nor the omission is visible from
  either document.
- [builder-studio.md](../architecture/builder/studio.md) §13 proposes **D-47 through D-55** —
  nine entries, correctly noting "latest is D-46". Several describe merged work (the
  evals harness, the provider seam, teams, the entitlement).
- [engine-protocol.md](../engines/protocol.md) records that kernel open question 11
  was decided on real material and both poles shipped — "*the decision-log entry for OQ11
  awaits ratification*". It has awaited ratification for a month. Kernel-design §13 still
  lists question 11 as open.

**A log that is missing its last ten entries and contains a duplicate number is not a
log.** This is the single most valuable asset in `docs/` and it is the one decaying
silently.

### F3 — Two logs, one stated rule, executed as duplication.

The rule is written down and is a good one — kernel-design's header: the master plan is
canonical for *decisions*, kernel-design for technical *shape*; a shape that forces a
strategy change gets a plan entry first, "then this document follows."

In practice "follows" has become "is restated at full length". D-30/K-20, D-37/K-33 and
D-45/K-37 are the same decisions written twice, in two files, under two numbers, at
several hundred words each — K-37 even labels itself "the kernel-side twin". That is
roughly a third of the recent log maintained in duplicate. Nobody decided this; it
emerged. It should either be embraced explicitly (with the twin relationship machine-
readable) or collapsed.

### F4 — A document marked "not approved" is cited as normative by both canonical logs.

[proposals/hosting-and-certification.md](../strategy/hosting-and-certification.md) opens: "**Status:
draft for review. Not approved, not merged into the plan.**"

It was approved and merged. It **is** master-plan **D-32** (2026-07-18) — hosting as the
monetization boundary, certification inheritance as the paid layer. Three weeks later both
**D-45** and **K-37** (2026-08-08) cite it as live authority: "hosting-and-certification.md
§3's shared-responsibility line". A reader who obeys the status line discards a document
the decision logs depend on.

### F5 — `docs/` versus `apps/docs/` has already caused a wrong path in the repo's own agent instructions.

[CLAUDE.md:159](../../CLAUDE.md) instructs every agent working in this repo to "See
`docs/concepts/model.md`". That path does not exist. The file is
`apps/docs/concepts/model.md`. `docs/concepts/` has never existed.

The two corpora are legitimately different things and both should exist — but they are
named as if one contains the other, and the first casualty was the instruction file
telling agents where to look.

### F6 — Five documents state an update date that contradicts their own git history.

| Document | Claims | Last commit |
|---|---|---|
| `master-plan.md` | 2026-07-28 | **2026-08-11** |
| `kernel-design.md` | 2026-07-28 | **2026-08-08** |
| `commerce-gaps.md` | 2026-07-17 | **2026-08-19** |
| `engine-protocol.md` | 2026-07-14 | 2026-07-20 |
| `connections.md` | 2026-08-10 | 2026-08-12 |

The two canonical documents are the two worst offenders, and in both cases the drift spans
decision-log entries added after the stated date. A hand-maintained date that git already
knows is a field that exists only to be wrong.

### F7 — Links are already broken, and ~30 more will break on any move.

Two broken relative links exist today:

- `master-plan.md` D-43 links `docs/architecture/preview-and-snapshots.md` — a repo-root path
  used from inside `docs/`, so it resolves to `docs/docs/design/...`.
- `research/fsm-vendor-feature-survey.md` links `../../demos/fsm/spec/concept.md` —
  `demos/fsm` was renamed to `demos/bike-shop` and then to `demos/handlebar`.

About thirty files outside `docs/` link into it (CLAUDE.md, README.md, skills, package
READMEs, source comments, `apps/docs` pages). Any directory move without a link check
multiplies these.

### F8 — `docs/design/` is five genres in one flat directory.

Forty files, no index, sorted only alphabetically, mixing: durable platform architecture
(kernel-design, control-plane, connections); engine specs; UI briefs written to be handed
to a design tool (dashboard-ui, manyfold-ui); milestone plans with a natural expiry
(first-flow, model-phase-plan); and strategy that is not design at all (commercial-model,
generated-verticals, commerce-gaps). `kernel-design.md` at 1,227 lines sits beside
`engine-metering.md` at 133 with nothing distinguishing their weight.

### F9 — `docs/` contains ten non-documents.

`docs/design/model-phase-spike/` is nine TypeScript files and a `tsconfig.json` — a
compile-check spike, not a document, and its subject shipped (contracts 0.74.0,
`packages/model-emit` 0.3.1).

*Corrected during Phase 1:* an earlier draft of this section also claimed `docs/.DS_Store`
was "untracked but not gitignored". It is gitignored, at `.gitignore:5`. The claim was
asserted from the absence of a tracked file rather than checked — the same failure mode
this document is about, committed inside it.

**Resolved (Phase 1).** The spike moved to `spikes/model-phase/` rather than being deleted,
and still typechecks clean from its new home. Deletion looked right by the K-28 precedent
(*"spike removed after recording; it is in git history at `368b340`"*) but that spike's
README asked to be removed, and this one asks the opposite — its failure suite *"belongs in
CI permanently, not as a one-off"*. Checking rather than assuming settled it: the shipped
packages now carry **47** `@ts-expect-error` type checks (40 in `packages/contracts/test`,
7 in `packages/kernel/test/typed-consumers.test.ts`) against the spike's 30, so the concern
is honoured and the spike is genuinely superseded. Moving costs nothing and leaves the
deletion to a human.

---

## 3. What is missing

### M1 — There is no index. `docs/` has no README.

The root README points at 5 of 55 files. Nothing tells a reader — or an agent — what
exists, which document supersedes which, or where to write something new.

### M2 — Documentation coverage is inversely correlated with maturity.

| Engine | First commit | Design doc |
|---|---|---|
| workorder | 2026-07-13 | **none** |
| invoicing | 2026-07-13 | **none** |
| protocol | 2026-07-14 | yes |
| booking | 2026-07-18 | yes |
| invites | 2026-07-19 | **none** |
| absence | 2026-08-14 | yes |
| metering | 2026-08-14 | yes |

The three engines with no design document are the three oldest and most composed —
`workorder` and `invoicing` are the reference pair the whole three-layer rule is taught
with, and `invites` is the one D-31 named as proving the two-consumer extraction rule. The
convention of writing an engine design doc started *after* they were built, and nothing
went back.

The same pattern holds one level up: the longest, most carefully argued documents in the
corpus describe the newest and least-settled work.

### M3 — The acceptance benchmark stopped, and a successor shipped with no document connecting them.

Master plan §5.6 calls the agent loop "**the recurring benchmark**" and "the question every
kernel API review should end with". Kernel-design §11 lists it as testing-strategy item 4.

Eight runs exist, all between 2026-07-14 and 2026-07-16. **None in the five weeks since** —
a period in which the platform gained three engines, the builder studio, the model phase,
the deploy pipeline, sub-transactions and a live production tenant.

Meanwhile `apps/builder/evals` shipped (`pnpm builder evals`) — a frozen-fixture regression
sweep for the studio's generator. It is a real benchmark and it is **not the same
benchmark**: it tests the studio's generation quality, not "can any agent build a vertical
against the published packages unaided". No document says whether it supersedes the
acceptance runs, complements them, or is unrelated. Either the acceptance benchmark is
five weeks overdue, or it was retired without a note. Both are worth knowing; neither is
recorded.

### M4 — The open questions are unranked, and two have passed their own deadlines.

Kernel-design §13 lists 17 questions in filing order. Read together they are wildly
uneven — and two carry explicit deadlines that have now arrived:

- **OQ16 — dual-emit is unimplementable, and the deadline has passed.** Consumer dispatch
  routes on event *type* alone; `schemaVersion` is declared, discarded at registration, and
  absent from the dispatch predicate. So D-28's dual-emit deprecation window "becomes the
  mechanism that double-processes" — for `invoicing.underlag-exported`, whose consumer is
  by design an accounting connector, "**a double invoice, silently, in production**". The
  question says *"Decide before a third party consumes an engine event; after that, the
  choice is someone else's outage."* **All seven engines are live on the public npm
  registry** — verified against it, not inferred from `private` flags:
  `engine-invoicing@0.7.1`, `protocol@0.9.1`, `workorder@0.6.1`, `absence@0.3.1`,
  `booking@0.3.1`, `invites@0.3.1`, `metering@0.2.1`. The condition the deadline was set
  against is met. This is no longer an open question; it is an unmitigated risk with a
  known blast radius. Tracked at
  [#128](https://github.com/substrat-run/substrat/issues/128), which is well-scoped but
  predates the publish — its "defer version pinning until external consumers exist" bullet
  is arguably already triggered (Phase 0).
- **OQ15 — entity re-parenting.** No `unlink` exists at any layer, so "a building changes
  management company" leaves the old manager's staff with permanent silent access. K-21
  narrowed the storage answer to a tombstone and left `relink` open. The doc says "decide
  before PropCo accumulates a year of links."

These sit in the same undifferentiated list as OQ4, "skew-window declaration format:
per-migration or per-release?".

### M5 — Nothing describes what is true *now* at architecture level.

There is a canonical record of *why* (the logs), a canonical record of what was *proposed*
(the design docs), and a published record of *how to use it* (`apps/docs`). There is no
document a new engineer or agent can read to learn what the platform currently does. It is
reconstructable only by reading 83 log entries and mentally applying the supersessions.

---

## 4. Conclusions that only appear when you read it all together

### C1 — The decision log is the product. The design docs are its scaffolding.

Eighty-three dated, argued, cross-linked entries — each naming what was rejected and why —
are the most valuable and most durable thing in this repository's documentation, and by a
wide margin. They are also the only part that survives contact with a changed
implementation, because a decision *stays true* as a record of what was chosen even after
the code moves on.

They are currently buried at the bottom of two 1,200-line files, with no index, no
supersession graph, and ten entries missing.

**The structure should be organised around the log**, with design documents as its
supporting material. Today it is the other way around.

### C2 — The lifecycle is a promotion pipeline, and no step of it is implemented.

Reading the corpus, every healthy document travelled the same path implicitly:

```
question → RFC/design doc → decision-log entry → shipped
                                    ↓
              description of what IS  →  apps/docs (published)
              record of why           →  the log (permanent)
              the design doc itself   →  history
```

Not one of those three arrows is executed anywhere. So design docs accumulate at the front
of the pipeline forever, and every one of §2's findings — the write-once status, the
shadow log, the "not approved" document being cited as law — is a different symptom of the
same missing machinery.

**This reframes the whole task.** A folder tree is a snapshot of a pipeline's output. If
the pipeline does not run, the tree is stale within a month and we will be here again.

### C3 — `docs/` answers *why*; `apps/docs/` answers *what*. Naming that dissolves the dedup question.

My first pass suggested deduplicating `docs/architecture/control-plane.md` against
`apps/docs/platform/control-plane.md`. Having read both, that is wrong. They are not
duplicates — one argues a decision (including rejected alternatives), the other describes
a working system to a user. Both should exist.

What is missing is the **promotion step** between them and the **naming** that makes the
split legible. `docs/` is the *decision record*; `apps/docs/` is the *manual*. Once that is
said out loud, the CLAUDE.md path bug (F5) becomes obviously a symptom, and "where do I
write this?" has an answer.

### C4 — Staleness here is structural, not editorial. Only a gate fixes it.

The corpus is meticulous — status lines everywhere, dated entries, explicit supersession
notes, `~~strikethrough~~` on answered questions, "honest limits" sections, rejected
alternatives recorded. This is *unusually* disciplined documentation. And it still decayed,
because every one of those disciplines is applied **at authoring time by a careful author**
and none of them is applied **at merge time by anything**.

This repo already knows the answer and applies it everywhere else: `lint:permissions`,
`lint:model`, `lint:api`, `lint:deps`, `lint:boundaries`, `lint:playbook`, `lint:docs`.
CLAUDE.md states the principle — *"CI going red is what makes the reading unskippable."*
Design docs are the one artifact class exempt from the repo's own rule.

### C5 — Three items in this audit are correctness bugs, not documentation debt.

Separable from any restructure, and higher priority than it:

1. **OQ16** — a published engine event with an unimplementable deprecation path and a
   silent double-invoice failure mode (M4).
2. **The D-41 collision and the ten unwritten entries** — the canonical log is wrong, and
   two decisions share a number (F2).
3. **`hosting-and-certification.md` is mislabelled "not approved"** while two log entries
   cite it as normative (F4).

None of these is fixed by moving a file.

---

## 5. The structure (built in Phase 3)

Organised by **what a document is for** and **where it is in the pipeline** (C2).

```
docs/
  README.md                 generated index: every doc, status, date, supersession
  DECISIONS.md              generated from decisions/ — the whole log, one table
  decisions/                one file per decision (§7) — the merged D+K log
  master-plan.md            strategy (the log moves out and is injected back)

  strategy/                 why we build this, for whom, at what price
    why-substrat.md  candidate-verticals.md  commercial-model.md
    generated-verticals.md  hosting-and-certification.md  commerce-gaps.md

  architecture/             what is true NOW — present tense (fills M5)
    kernel-design.md  control-plane.md  dashboard.md  membership.md
    connections.md  platform-intents.md  scheduler.md  observability.md
    self-serve-deploy.md  preview-and-snapshots.md  api-surface.md  orchestration.md
    scope-local-permissions.md  permission-registry-enforcement.md
    dependency-policy.md  platform-neutral-surface.md  oidc-only-demos.md
    signature-contact-carrier.md  dashboard-teams.md  vertical-auth-detach.md
    builder/                plane, studio, harness — one subsystem, three docs

  engines/                  one per engine, mirrors engines/* — INCLUDING the
                            three that have none today (M2)
    absence.md  booking.md  invites.md  invoicing.md
    metering.md  protocol.md  workorder.md

  rfc/                      open proposals only — leaves when decided
    sub-transactions.md  agent-surface.md  marketplace-publish.md
    multi-scope-manyfold.md  cms-content.md  booking-social.md  model-phase-plan.md

  briefs/                   short shelf life by design
    dashboard-ui.md  manyfold-ui.md  first-flow.md

  research/                 dated external snapshots, never revised
  acceptance/               dated run records, append-only
  archive/                  superseded — kept, not maintained
```

Two rules carry the weight:

1. **`architecture/` is present tense.** A document there may not say "will", "proposed",
   or "not built". That single rule is what would have caught `dashboard.md`.
2. **`rfc/` empties.** A decided RFC moves to `architecture/` (rewritten) or `archive/`,
   and lands an entry in the log. A document that never leaves `rfc/` is a visible signal.

`model-phase-spike/` moves to `spikes/` or is deleted per the K-28 precedent; `.DS_Store`
gets gitignored.

---

## 6. Frontmatter and a closed status vocabulary

**Applied in Phase 1** to all 55 documents. The vocabulary gained one value in contact with
the corpus: `canonical`. The master plan, the kernel design, `why-substrat.md` and
`candidate-verticals.md` are living references that are never "built" or "proposed" and
never stop being revised — forcing them into a lifecycle word would have been the first lie
the new scheme told.

```yaml
---
status: built          # canonical | proposed | accepted | building | built | superseded | historical
layer: kernel          # plan | kernel
description: One line. Feeds the generated index.
decision: D-47         # the log entry, once it exists
tracking: "#770"
supersedes: orchestration.md
superseded-by: ~
---
```

`updated:` is deliberately **absent** — git already knows, and a hand-kept date is a field
that exists only to go wrong (F6). Phase 1 retired six of them; the two that survive are a
genuine survey date and a commit date that happened to be right.

Rules: `built` requires `architecture/` or `engines/` **and** a `decision:` that resolves.
`superseded` requires `superseded-by`. `historical` (research, acceptance, consumed briefs)
and `canonical` are exempt from freshness checks — the first because it is never revised,
the second because it always is.

The distribution as applied: 28 `built`, 14 `historical`, 4 `canonical`, 4 `building`,
4 `proposed`, 1 `accepted`.

Decision entries carry a different schema — §7.

---

## 7. The decision log becomes a directory of files

**Decided: one log, merged. Renumbering deferred** — existing ids stay as they are, and
§7.4 records why that is the cheap order rather than a postponement. This section is the
mechanics.

### 7.1 Why the log cannot stay a markdown table

Three measurements settle the format question without appeal to taste.

- **Entries are single table rows up to 4,370 characters.** D-31 is one cell holding ~650
  words; the two logs together are **17,400 words** in two table bodies. Git diffs by line,
  so any amendment to an entry renders as a full-line rewrite — **you cannot review a
  change to a decision as a diff**, which is the one review mechanism this repo trusts.
- **The numbering is already corrupt from concurrent appends.** D-37 is dated 2026-07-27
  and D-38 is dated 2026-07-26: numbered out of order because two branches were in flight,
  dates coming from authoring and numbers from merge. That is the same mechanism that
  produced the D-41 collision (F2). Every branch adding a decision edits the same line
  region of the same file.
- **The relational structure already exists in prose.** Across 83 entries: *implements* ×12,
  *completes* ×7, *amends* ×3, *supersedes* ×3, *refines* ×3, *narrows* ×3, *extends* ×2,
  *corrects* ×2, *revises* ×1, plus 29 distinct issue references. Thirty-six edges of a
  graph, hand-built, unqueryable.

This is the same argument D-39 already made about the permission registry — *"a second
source of truth for a code-declared fact — drifts by design"* — applied to the log itself.

### 7.2 The shape

One file per decision; the existing prose becomes the body, unchanged and finally readable.

```
docs/decisions/
  D-031-admin-record-keeping-becomes-a-vertical.md
  D-045-subject-erasure-splits-by-store.md          ← absorbs K-37, its restatement
  K-022-membership-seam-is-a-connector.md
  D-047-permission-registry-typescript-derived.md   ← the entry that never landed (F2)
```

Ids keep their existing prefixes and numbers. They are already unique across the merged set
by construction, so the merge needs no renaming at all.

```yaml
---
id: D-45
date: 2026-08-08
layer: kernel                 # plan | kernel — preserved as metadata, not as a second log
title: Subject erasure splits by store
status: accepted              # accepted | superseded | amended
aliases: [K-37]               # ids that resolve here — the three collapsed twins (§7.3),
                              # and the landing pad for a later renumber (§7.4)
implements: [D-22]
supersedes: []
answers: [OQ-17]
tracking: ["#37"]
---
```

Two id rules follow, and both are lintable:

- **New entries continue one sequence from D-47.** The `D` stops meaning *plan* and starts
  meaning *decision* — which is what a merged log needs — with `layer:` carrying the
  distinction the prefix used to. `K` is never issued again but every existing `K-n`
  stays valid forever.
- **The permission-registry entry takes D-47, not the colliding 41** (F2), and
  builder-studio's proposed D-47…D-55 shift down one as they land. No existing id moves.

`DECISIONS.md` is generated from the directory. Master plan §12 and kernel-design §14 keep
their sections but their tables are **injected**, not authored — the same emit-and-diff
pattern as `PERMISSIONS.md`, `model.json` and `openapi.json`.

### 7.3 Merging is not collapsing

One log means one sequence and one index. It does **not** mean deleting entries, because
the D→K relationship is mostly *altitude*, not duplication:

- **Legitimately two entries** — D-26 decides that verticals refine engine states via
  substates; K-17 specifies the manifest declaration that implements it. Same for D-22/K-9,
  D-23/K-12, D-31/K-21+K-22. These keep both entries and gain an explicit `implements:` edge.
- **Genuinely one decision written twice** — D-30/K-20, D-37/K-33, D-45/K-37, where the
  kernel entry restates the plan entry at length (K-37 calls itself "the kernel-side twin").
  Only these three collapse, into a single entry carrying both ids via `aliases:`.

So 83 entries become ~80, and the merge is mostly a re-filing rather than a rewrite. A
collapsed twin keeps the plan-side id and lists the kernel-side one in `aliases:`, so both
existing references keep resolving.

### 7.4 Why renumbering is deferred, and what makes it cheap later

Renumbering into a single 1…80 sequence is attractive and is **not** on this plan. The
measurement is why: it is a **~1,490-site mechanical rewrite plus ~700 references that
become permanently wrong**, and the second number is the one that decides it.

| Where | Refs | Rewritable |
|---|---|---|
| `packages/`, `engines/`, `apps/` source (`*.ts`) | **763** | yes — but it is a sed across the kernel's most sensitive files |
| `docs/` markdown | 634 | yes |
| `apps/docs/` published site | 45 | yes |
| `demos/`, `engines/` markdown | 49 | yes |
| **package `CHANGELOG.md`** | **374** | **no** — published release notes; rewriting history in shipped changelogs |
| **git commit messages** | **325** | **no** — immutable |

Two of those rows cannot be rewritten at all. Package `CHANGELOG.md` files are **published
release notes** — rewriting them edits the shipped history of packages already on npm — and
git commit messages are immutable. So a renumber does not replace one vocabulary with
another; it guarantees two vocabularies forever, one of which is frozen in ~700 places.

The row worth pausing on is **763 in source**: `packages/kernel/src/scope-host.ts`,
`packages/adapter-sqlite/src/index.ts` and `packages/control-plane-api/src/api.ts` cite
decision ids as load-bearing comments — the path a reader takes from code back to
rationale. Those are the references that most need to keep working, and they sit in the
files where a careless sed is most expensive.

**Deferring costs nothing, because the split is what a renumber is expensive without.**
Once entries are files with an `aliases:` field and a generator that resolves it, a later
renumber is a mechanical pass: assign new ids, move the old ones into `aliases:`, regenerate.
The lint already resolves both vocabularies, so nothing outside `docs/decisions/` has to
change on the day — references can be rewritten opportunistically or never. Doing the split
now and the renumber later is therefore strictly cheaper than doing both together, and it
keeps the risky part (a sed across the kernel) out of the change that has to land first.

What this asks of Phase 2 in return: ship `aliases:` from the first migrated entry even
though only the three collapsed twins populate it. An empty field costs nothing; retrofitting
one onto 80 files after they exist is the same trap K-22 records for `OrgId` and K-24 for
`drained_at` — ship the column before the consumer.

---

## 8. The gate — `lint:docs` extended to `docs/`

[tools/docs-drift.mjs](../../tools/docs-drift.mjs) already measures published-page rot
against source churn. Point the same tool at `docs/` and add four checks, each of which
catches a specific finding above:

| Check | Catches |
|---|---|
| unknown/missing `status`; `built` outside `architecture/`; `built` without a resolving `decision:` | F1 — dashboard.md, orchestration.md, 16 more |
| every `decision:` resolves to a real, **unique** entry; no id or `aliases:` entry is claimed twice; the `D` sequence has no gaps past D-46 | F2 — the D-41 collision, the ten missing entries |
| every relation edge (`implements`/`supersedes`/`amends`/`answers`) resolves to an existing entry or open question | the 36 hand-built edges of §7.1, now checked |
| regenerate `docs/README.md`, `docs/DECISIONS.md`, and the injected §12/§14 tables; `--check` fails on drift | M1, C1, §7.2 |
| every relative link resolves | F7 — the two live breaks, and the ~30 the move creates |

Two more worth adding once the above is green: warn when an `architecture/` doc's subject
directory has churned past a threshold since the doc last moved (the existing drift metric,
pointed inward), and fail when a `rfc/` document's `tracking:` issue is closed — that is
exactly the moment a decision needs writing back.

---

## 9. Sequencing

**Phase 0 — the correctness backlog. ✅ Done 2026-08-19.**

- `hosting-and-certification.md`'s status corrected — it is D-32, accepted and merged, and
  all four of its proposed edits were located in the plan (the log row, the §6 build/buy
  row, the §7.4 paragraph, the §5.7 amendment). Marked live-not-historical, since D-45 and
  K-37 cite its §3.
- `CLAUDE.md` → `apps/docs/concepts/model.md` (F5).
- `master-plan.md` D-43's repo-root link → `design/preview-and-snapshots.md`; the FSM
  survey's `demos/fsm/spec/concept.md` → `demos/callout/spec/concept.md`, confirmed by the
  rename in git (`R087`, not the `bike-shop`→`handlebar` line) (F7).
- OQ16: **an issue already existed** — [#128](https://github.com/substrat-run/substrat/issues/128),
  open since 2026-07-21 and correctly scoped. This plan was wrong to say "open an issue";
  the right act was a comment recording that the deadline passed, with the registry check
  as evidence. Done.

The **ten missing decision entries are deliberately not in Phase 0** — they need the file
split (Phase 2) to land cleanly, and appending ten rows to a table that is about to be
deleted is wasted work.

**Phase 1 — legible without moving anything. ✅ Done 2026-08-19.**

- Frontmatter on all 55 documents (§6), each status verified against the repo or a tracking
  issue rather than taken from the document's own claim.
- **18 body status lines corrected** so a document no longer contradicts its own header —
  `dashboard.md` and `orchestration.md` no longer open with "Not built"; `cms-content.md`
  and `connections.md` no longer say "before any code"; the four engine docs no longer read
  "draft v0.1".
- Six stale hand-kept dates retired (F6). `master-plan.md` and `kernel-design.md` now say
  *"see `git log` for currency, not this line"*.
- [`docs/README.md`](../README.md) written — the map, the where-to-write-what table, the
  vocabulary, a known-gaps section, and a 55-row index. All 56 of its links resolve.
- The spike moved to `spikes/model-phase/` (F9), still typechecking clean.
- Nothing archived: on inspection almost nothing here is *dead*, only mislabelled. The one
  genuinely superseded artifact was the spike, and it moved rather than died.

Two content findings surfaced while assigning statuses, both logged in
`docs/README.md` and deferred to Phase 4:

- **`commerce-gaps.md` §6.1 is now false.** It says engines have *zero dedicated tests* and
  there is *no engine analogue of `packages/contract-tests`*, calling this "the
  precondition" that "outranks everything else here". All seven engines now have a `test`
  script and 18 test files between them, and `packages/engine-test-kit` exists. The
  document is marked `historical` with the defect named in its own status line.
- **`engines/{workorder,invoicing,invites}` still have no design document** (M2).

**Phase 2 — split the log. ✅ Done 2026-08-19.**

- 83 entries → `docs/decisions/`, one file per entry, **ids unchanged**, `aliases: []` on
  every file. [`tools/decisions.mjs`](../../tools/decisions.mjs) renders the master-plan §12
  and kernel-design §14 tables and `docs/DECISIONS.md` from them; `pnpm lint:decisions`,
  `--check` in CI beside `lint:permissions` and `lint:model`.
- **Losslessness proved before anything was deleted.** The generator reproduced both tables
  byte-identically from the 83 files — all 37 K rows and 45 of 46 D rows unchanged against
  `HEAD`, the single difference being D-43's link, fixed deliberately in Phase 0.
- **Eleven missing entries landed** (F2): D-47 permission registry, D-48…D-56 builder studio,
  K-38 kernel open question 11. Transcribed from their authors' own text — the source
  documents now point at the landed ids, and kernel-design §13 no longer lists question 11
  as open.
- The gate was tested against the defect that motivated it: re-numbering D-47 back to 41
  fails with *"id D-41 claimed by both …"* plus both sequence gaps.

One deviation from this plan as written, ratified on review:

**The three twins are cross-referenced, not collapsed.** Collapsing D-30/K-20, D-37/K-33
and D-45/K-37 means merging two pieces of prose that restate each other differently — an
editorial act, and one that would make the byte-identical proof impossible for exactly the
entries where losing text would hurt most. They carry a `twin:` field the generator
validates, and each renders a cross-reference in **both** tables:

> *(Restated at the other altitude as [K-20](…) — same decision, kernel layer.)*

That is what a reader of either table actually needs — *this is the same decision you may
have already read*, with somewhere to go — and it makes the duplication F3 identified
legible instead of accidental. It also leaves the option open: a later collapse is a merge
of two files, and the `twin:` edge is what would drive it.

**The eleven transcribed entries were ratified 2026-08-19** and carry `status: accepted`.
They were landed as `proposed` — rendering as **[awaiting ratification]** — because an
agent writing decisions into the canonical log and marking them approved is the
self-approval this repo's checkpoints exist to prevent. A human read them and flipped the
field, which is the checkpoint working rather than a step skipped.

No reference anywhere else in the repo changed. That was the point of doing it before any
renumber.

**Phase 3 — the move. ✅ Done 2026-08-19.**

44 documents into `strategy/ architecture/ architecture/builder/ engines/ rfc/ briefs/`;
`design/` and `proposals/` are gone. Driven from an explicit move map, validated for missing
sources and colliding destinations before a single `git mv`.

The link pass was the whole of the risk, and it had three failure modes worth recording
because each was invisible to the obvious approach:

- **Relative links must resolve against a file's OLD directory.** Two documents that were
  siblings in `design/` and are now in `architecture/` and `rfc/` referenced each other as
  bare `kernel-design.md`. Resolving that against the *new* location silently finds nothing
  to rewrite and leaves a broken link. 84 links needed the old-base pass.
- **A moved file breaks links to targets that did not move.** `why-substrat.md` going one
  level deeper turned `../apps/docs/guide/faq.md` into `docs/apps/…`. Nothing about the
  target changed; only the referrer's depth did.
- **Paths hide from a grep.** `.jsonc` was missing from the file filter, and two source
  comments wrapped `docs/design/scope-local-permissions.md` across a line break mid-path.

Final state: **every relative markdown link in every tracked file resolves**, and no file
outside this document and one explanatory comment mentions the old tree.

Two things fixed in passing, both pre-existing rather than caused by the move: four package
CHANGELOGs pointed at `docs/design/…` from a depth that never resolved, and four demo specs
still linked `demos/fsm` and `demos/bike-shop`, renamed long ago. **Changelog paths were
rewritten, decision ids in changelogs are not** (§7.4) — the distinction is that a path is a
pointer to the same document, while an id is that document's identity.

**Phase 4 — the gate, then the content debt.**
Extend `lint:docs` per §8. Then the writing work Phase 1 only labelled: rewrite the ~18
`built` docs in present tense, and write the three missing engine docs (workorder,
invoicing, invites).

**Not scheduled — the renumber.** Available at any later point at the cost of one
mechanical pass over `docs/decisions/`, per §7.4. Revisit when the two-prefix vocabulary
actually causes friction; it may never.

**Deliberately out of scope:** whether `strategy/` belongs in this repo at all.
[why-substrat.md](../strategy/why-substrat.md) states it contains material a public page must not —
venture risk, named customer concentration, unreleased work. That is an argument for
keeping it *and* a reason the placement should be a deliberate call rather than an
inheritance. It needs a decision, not a folder.

---

## 10. Review questions for the human

Question 1 — *do D and K merge?* — is **decided: yes, one log, ids unchanged**; renumbering
is deferred and unscheduled (§7.4). What remains:

1. **Is the acceptance benchmark alive?** (M3.) If `builder evals` replaced it, that is a
   decision entry. If not, run 009 is five weeks overdue and the answer belongs in
   master-plan §5.6.
2. **Does `strategy/` stay in this repo?** (§9.)
3. **Does OQ16 get an interim answer now?** It is tracked ([#128](https://github.com/substrat-run/substrat/issues/128))
   and the deadline has passed. The cheap move may be to strike D-28's dual-emit clause in
   favour of loud-failure replaces until routable dispatch lands — so the written rule and
   the executable behaviour stop disagreeing. That is a decision entry, not a code change.
4. **Do new kernel-layer decisions really take a `D` id?** (§7.2.) It is the honest reading
   of a merged log and it is mildly jarring the first time. The alternative — keep issuing
   `K` ids for kernel-layer entries — preserves the habit but keeps two counters alive,
   which is what produced the collision this proposal exists to fix.
