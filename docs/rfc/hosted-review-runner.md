---
status: accepted
layer: plan
description: The platform-hosted half of the Substrat review checklist (#2365). Accepted — every question was decided on 2026-10-18. One runner-neutral checklist, no model key in GitHub CI, mechanical gates first, the model trusted only for judgement items, advisory until a platform-owned script confirms; the reviewed change is a full-tree upload with the push, later the input of a controlled build. Decided: one pinned platform model behind the platform gateway, metered and budget-capped; a staff-granted entitlement plus a per-vertical switch; the review record as a first-class platform object that every surface views; promotion (never upload) gated on script-confirmed blocking findings once the platform builds the bundle; immutable, stored checklist versions; a seeded corpus kept running; findings readable by the owner tenant's source-bearing roles and the pushing credential, installers seeing at most a pass/fail summary the owner publishes.
---

# RFC: the hosted review runner

**Status: accepted** (every question of §6 decided by the human on 2026-10-18; §7 collects the
answers; no decision-log entry yet, so this RFC is the record of what was decided; nothing here
is built yet). It answers the part of
[#2365](https://github.com/substrat-run/substrat/issues/2365) that #2368 left open: the hosted
runner. §2 records what was decided before the questions were asked, and §2.2 is now decided as
well (Q6d). Each question in §6 keeps its options, the reasoning and the cost of being wrong, and
opens with a **Decided** line giving the answer. Where the answer differs from what the first
revision recommended (Q10), or adds to it, the question says so. Q9 was decided before the others
(§2, D5); its number is kept so the other answers keep theirs.

Written against `origin/main` at `2a8c2712c`; the decisions were folded in against `23e90d2d2`.
References are to sections and symbols, not lines. Issues and PRs are cited by number only.

---

## 1. The problem

A Substrat vertical fails in ways that look like success. A query that reaches around the
kernel, a handler that checks a weaker permission than the model declares, a hand edit to a
generated file, a migration that drops a column's data: each compiles, passes its own tests and
renders. A general code review (an editor's built-in one, a pull-request bot) does not know
Substrat's rules, so it does not see them.

#2368 wrote those rules down once, as `plugin/substrat/review/checklist.md`, and shipped one
runner for them: the plugin's `review` skill (`/substrat:review`), which a builder runs in their
own session, on their own model credits, before they push. That covers a builder who remembers
to run it. It does not cover:

- a builder who does not run it, or an agent that pushes without it;
- a change made in the builder studio or by an agent loop the platform hosts;
- anyone who wants to know, after the fact, whether a version that is now serving was reviewed,
  against which rules, and with what result.

#2365's original answer was a GitHub Actions job holding a model key. That answer is withdrawn
(§2, D2). This RFC is about the runner that replaces it.

## 2. Already decided

These were decided before §6 was asked, and the questions in §6 are asked inside them. §2.2 is a
requirement this RFC derived from D4; the human confirmed it as written (Q6d, 2026-10-18).

**D1 — One checklist, any runner.** `plugin/substrat/review/checklist.md` is the only copy of
the rules. The local skill reads it today; the hosted runner reads the same file (Q5 says how).
No runner carries its own copy. (#2368.)

**D2 — No model key in GitHub CI.** A customer's code is not in this repository, and a hosted
review belongs behind the platform: **enabled per customer, metered by the platform, and
independent of where the customer's git lives** — GitHub, another host, or a repository the
platform manages itself (as D-53 already does for verticals the builder studio generates). The
`claude-code-action` workflow an early revision of #2368 carried was removed. (Decision recorded
on #2365.)

**D3 — Mechanical gates first; the model only where no script can decide.** Every checklist
item a script can decide is being turned into a real gate in separate work (the same move #2368's
checklist already makes when it names a gate per item). The hosted runner is built **on top of**
those gates: it runs them, and it asks a model only about the items, or the parts of items, that
are marked `judgement` — what no script can decide (is this new field personal data, does this
check grant less than the operation needs, does a declared `discards` reason match what the SQL
does).

**D4 — Advisory by default; only a script may block.** Every finding starts advisory. A finding
can ever block anything only if a script confirmed it. A model's finding never blocks, whatever its
item's severity and whatever confidence the model claims. (What "a script confirmed it" has to mean
for a hosted runner was not part of this decision; §2.2 says it, confirmed as Q6d.)

**D5 — The reviewed change is uploaded with the push now, and built from later** (decided by the
maintainer on this RFC's first revision, where it was Q9). The platform receives a built bundle,
never source (§3), so a reviewer has nothing to read unless source reaches it. Of the three ways
the first revision laid out:

- **A — the CLI uploads the source with the push** is used for phases 1–3 (Q8). It is the only
  way that is independent of the git host (D2) and needs no new connector.
- **C — a controlled build**, where the platform builds the bundle from that source in its own
  sandbox (`docs/architecture/self-serve-deploy.md` §3, model A), follows A. With C the reviewed
  source is the deployed source by construction, which A cannot show: under A the source and the
  bundle are uploaded side by side, and nothing ties one to the other. C is therefore the
  precondition for phase 4, the first phase in which a finding may refuse anything (Q4).
- **B — the platform reads a git repository it was granted** is dropped. Read access to the
  customer's git is not guaranteed, and B would still not tie the bundle to the commit.

**A is designed as C's input.** One format, one digest, stored with the version: the upload is the
**full source tree** of the version as pushed (not a diff — the gates need the whole tree to
install, typecheck and run), packed in one archive format, identified by the digest of that
archive, and stored beside the version record it was pushed with (or, for a phase-1 review of
one of Substrat's own branches, which has no version, with its review request, Q8). When C
arrives it builds from that same archive, so moving from A to C changes who builds, not what is
uploaded or stored. When an archive is uploaded, how long it is kept and what the diff is taken
against are Q3b's.

D3, D4 and D5 together are the builder studio's verification rule applied to review: *rank checks
by who authored the oracle* (`docs/architecture/builder/studio.md` §9). A gate whose expected
output is derived from committed artifacts is high-trust; a model's reading is a reading.

### 2.1 What D4 does to the checklist's vocabulary

The checklist today has one axis, **severity**: an item is `blocking` ("the change is unsafe to
merge as written") or `advisory` ("worth a comment, never a stop"). D4 adds a second axis that the
checklist does not yet carry, **confirmation**: was this finding decided by a script, or by a
reader. The two are independent. The table uses §2.2's meaning of *platform-owned*:

| | confirmed by a platform-owned script | judged by a reader (person or model), or by a customer-owned script |
|---|---|---|
| **severity `blocking`** | may block, once Q4 allows it | shown prominently; never blocks |
| **severity `advisory`** | never blocks | shown; never blocks |

So "S5 · Personal data is classified and erasable: blocking" stays a blocking-severity item, and a
model's S5 finding is still advisory, because no script confirmed it. The checklist's report shape
already has the hook for this: a finding the reader could not settle is `[S5 unconfirmed]`. The
per-item `judgement` mark the gates work introduces is what the hosted runner reads, rather than a
list kept inside the runner (Q5d).

### 2.2 Decided (Q6d): what makes a script's result platform-owned

This subsection is what this RFC derived from D4 for a hosted runner. The human confirmed it as
written (Q6d, 2026-10-18): these conditions are the requirement for **any** blocking, and only a
gate that meets all of them counts as script-confirmed. At first that may be the boundaries gate
alone (below).

A gate result counts as *script-confirmed* in the sense of D4 only when all of the following hold.

1. **The tool is the platform's.** The gate runs from the runner's own pinned, read-only tool
   image, never from the customer's tree, `node_modules` or package scripts. In a project made by
   `npm create substrat`, the checklist's boundaries gate is `npm run lint:boundaries` — the
   customer's own script, which runs whatever their `package.json` says. The hosted runner calls
   its own pinned boundary-lint against the tree instead, and never the project's script. The
   same holds for every gate the checklist names by a project script.
2. **The inputs are the platform's, too.** Every input that decides the verdict, other than the
   source under review, comes from the platform or is pinned and verified by it: the gate's own
   configuration (for boundary-lint, its config file and its allow-hatches), compiler options and
   the types the compiler resolves, and which `@substrat-run/*` packages are present, at which
   versions, with their integrity checked — engine table ownership included. Two inputs need
   saying outright:
   - *What a gate judges.* The set of files boundary-lint judges is everything reachable from the
     vertical's module registrations. It is not a fixed set of directories, and not the tree's own
     statement of which directories count as module code. Three rules make "reachable" mean
     something:
     - *The edges.* Reachability follows static imports, re-exports and type-only imports, under
       resolution rules that are the platform's (path mapping, package `imports`/`exports`,
       aliases), never the tree's. An edge the platform cannot resolve statically — a computed
       `import()`, a `require` of an expression, code built at run time — is reported as a finding,
       and the boundaries result for that vertical is **not clean**.
     - *The entry.* The entry the graph starts from is declared by the tree, so it is only as good
       as its tie to what runs. The judged entry must be the one the deployed bundle was built
       from, which only the controlled build (D5 C) can show. Under C, the judged set is the set of
       modules the controlled build actually bundles. Under D5 A (phases 1–3), the judged set is
       taken from the declared entry, and the result is advisory and says so.
     - *The compiler's input.* The compiler gate's `include`/`files` are the same reachable set,
       not the tree's own `tsconfig` selection.
   - *What steers the compiler.* Suppressions in the source under review (`@ts-ignore`,
     `@ts-expect-error`, `@ts-nocheck`), augmentation of a platform package's module declarations,
     and type declarations supplied by third-party packages all change the compiler's verdict. They
     are hatches in the sense of this condition.

   A configuration or hatch that the change itself adds or widens — a gate's own, or one of the
   compiler hatches above — is reported as a finding of its own and is never read as clean for the
   rule it affects. A **full-tree review** (the first review of a vertical, or one whose diff base
   has expired, Q3b) has no change to measure against, so it reports **every** hatch and every
   non-default configuration in the tree as a finding; none is honoured silently because it was
   there before.
3. **Reading before customer code runs.** Gates that read source as text run before any customer
   code executes, in a filesystem that step never shares, with only platform-verified packages
   present. Not every text gate can run before an install: boundary-lint's engine-ownership rule
   needs the declared engines installed, so they are installed first from platform-verified
   packages under condition 4.
4. **A clean install the project does not configure.** Where a gate needs dependencies, they are
   installed from a clean state, with package lifecycle scripts disabled, with the project's
   package-manager configuration and hooks ignored (`.npmrc`, `.pnpmfile.cjs`, the
   `packageManager` field), and from the runner's registry.
5. **The verdict is observed, not reported.** Only an exit status observed by the runner's own
   process counts. Text a gate prints is never parsed into a pass or a fail.
6. **No customer code runs in the process that gives the verdict.** A gate that loads the
   vertical's code to decide — `lint:permissions --check` loads the built modules, `lint:model`
   loads `spec/model.ts`, the migration fence imports the authored migrations — does not meet
   this as it stands, so its exit status is not a platform-owned verdict.
7. **The gate environment holds no write credential**, including no credential to the review
   record (§4).

The archive itself is the first customer input the runner parses, so the **unpacker** (§4) holds
no credential: its read access is a single-use handle to the review's archive and its base archive,
issued per review and expiring with it. Before extracting, it checks each archive's digest against
the digest the version record holds (D5) — or, for a phase-1 review of one of Substrat's own
branches, which has no version record, the digests recorded when staff uploaded the archives and
named in the review request (Q8) — and refuses a mismatch. It extracts under these rules:

- no absolute paths and no `..` entries;
- no symlinks or hardlinks at all, which also rules out writing through a link an earlier entry
  of the same archive created;
- no device files, FIFOs or sockets, and setuid, setgid, sticky and other special mode bits
  dropped from every file;
- no duplicate entries, and no two entries whose paths are equal after case folding or Unicode
  normalization;
- bounds on total size, per-file size and file count, measured after decompression.

A script that does not meet all seven is **customer-owned**: the customer's own tests (the
`scenario` gate runs them) and any project script are in this class. Their results are reported,
with their output treated as untrusted text (Q6a), and they never confirm a finding. If these
conditions cannot be met for a gate, that gate cannot block, whatever Q4 says.

**Which gates could qualify.** Against conditions 2 and 6, the honest expectation today is that
boundary-lint can be made platform-owned (its engine-ownership rule only once engines come from
platform-verified packages), that the compiler gate can be only if its options and types are the
platform's, and that the gates which load the vertical's code cannot, as they are built now. So
the set of checklist items a script may ever block on may be as small as S1. §9 lists this as
unverified, and Q4 says what it means for blocking.

## 3. What exists

| Need | What `main` has | Gap |
|---|---|---|
| The rules | `plugin/substrat/review/checklist.md`: eight items S1–S8, each with a severity, a *Gate* line and a *Reader* line; a fixed report shape (`Substrat review: <n> blocking, <m> advisory`, `file:line`, quote, fails-when, fix; `Checked clean`, `Not applicable`, `Gates run`). | No version or digest of its own; it rides the plugin's version (`plugin.json` `version`, 0.3.0). No machine-readable `judgement` mark yet (in flight, D3). |
| A procedure | The `review` skill: diff against the merge-base, run the gates read-only, read each item, **try to disprove each candidate**, report. Never edits, never passes a checkpoint. | The procedure lives in the skill, not beside the checklist, so a second runner would have to copy it (Q5c). |
| A gate runner over a sandbox | `packages/builder-workspace`: `gates.ts` runs the tier-1 gates (`install`, `model`, `typecheck`, `boundary-lint`, `permissions`, `api`, `scenario`, `migration-replay`) and reports `passed`/`failed`/`blocked`/`skipped`; under the `substrat` exit convention, exit 2 from Substrat's own tools reads as *blocked* ("we learned nothing"), never as *failed*. `container.ts` runs the same `Workspace` seam over a Cloudflare Sandbox container. | Built for the studio's own loop, where the code is ours to run. Nothing runs it against a pushed vertical's change. `install` runs first and the later gates run from the project's tree, which §2.2 does not allow for a platform-owned result. `runGates` reports `ok` when every gate is `passed` **or `skipped`**, which §5.1 does not allow either. |
| Model calls and their ledger | `@substrat-run/model-providers` (provider table, catalogue, generated rate card); `createModelHost` in `@substrat-run/vertical-host` with an optional `guard` consulted before the call (the budget seam) and a `record` that yields one `ModelUsageLine` after it. A vertical raises the line as a `model-usage` platform intent and the drain writes it to the platform's ledger, kept 400 days (`MODEL_USAGE_RETENTION_DAYS`); the margin (`MODEL_MARGIN_PERCENT`) is applied at read time. The HTTP gateway row sends `cf-aig-collect-log-payload: false`, so the gateway logs counts and cost, not prompts. D-59. | The host runs **in the vertical**, so the line is self-reported and no budget is enforced on that path; #1073 designs the platform-side, connector-shaped host and is not built. The `env.AI` binding path names no gateway (D-59), so the payload-log setting does not apply on it. The review runner is platform code, so it can construct the host itself and write an observed line. `ModelAttribution` is fixed at five keys and **requires a `scope`**; a review is about a vertical version, not a scope (Q1b). |
| Metering a tenant's usage in its own scope | `engine-metering`: an append-only ledger of quantities inside a scope, deduplicated per meter, with closed periods. It knows no prices and enforces no limit. ticket0 records its assistant's tokens there beside the platform intent. | A review runs outside every scope, so the engine is not where a review's cost lands; the model ledger is. Nothing meters container time. |
| What the platform holds of a push | A **built bundle**, never source: the deploy endpoint runs in a Worker and cannot bundle (`docs/architecture/self-serve-deploy.md` §2). `versionOrigin` records `source` (`git`/`cli`), `gitRepo`, `gitCommit`, `gitRef`, and the CLI's push-gate receipt `gate` (`passed`/`skipped`/`none`, #955), all self-reported: *"the platform never lints the uploaded bundle (it receives built output, not source)"*. | **No copy of the change to review.** D5 adds the source archive. |
| A link to the customer's git | The dashboard's GitHub App: installation tokens, repository and branch listing, `pull_request` webhooks, and `upsertPrComment`, which keeps one marked comment per pull request up to date. Repository CI setup (`setupRepoCi`) needs the installation to hold contents, workflow and secret write, and reads one file's metadata to update the workflow. It reads no source; *"The platform cannot build a PR's code — the repo's own CI does."* | GitHub only, and an installation that can write. Not used to obtain the change (D5 drops B). |
| Where a version is shown | The dashboard's Deployments tab, per vertical and per version, where `OriginTag` already renders the push-gate receipt and flags anything but `passed`; the promote dialog, backed by `PromotionReview` (the permission and migration diff); the console for staff; `substrat push` / `substrat versions` output. | No review status anywhere. |
| Tenant-facing findings | The findings store (#1748): per tenant, recurring operational findings with a status (`open`, `acked`, `resolved`, `suppressed`) and suppress rules. An open or acked finding quiet past the 180-day horizon (`FINDING_RETENTION_DAYS`) is resolved as stale; a resolved or suppressed one past it is deleted. | A different thing with the same word: those are recurring and keyed by fingerprint, a review finding is about one version's code (Q3b). |
| Turning a feature on for a tenant | Entitlements, stored in the directory and projected into each scope; granted per tenant by staff from the console. The builder studio's own entitlement is the precedent. | No review entitlement or per-vertical switch (Q2). |
| Staff reads | Every staff read of the directory is recorded in the access log (K-24). | The review record's own store (Q3b) is not the directory; its staff reads are logged only if they go through the same logged path (Q10). |

## 4. The shape

Whatever the answers below, the runner has four parts, and no two share a process or a
credential.

- **The unpacker** takes the source archive (D5) and the archive of the diff base (Q3b), extracts
  them under §2.2's extraction rules, and computes the diff. It holds no credential and executes
  nothing from either tree.
- **The gate half** takes the extracted tree, runs the gates in a disposable container under
  the conditions of §2.2, and returns each gate's name, status and exit code.
- **The reader half** takes the diff, the checklist, the procedure and the gate half's structured
  results, asks one model about the `judgement` items only, and returns candidate findings.
- **The assembler** is the only part that writes. It checks each candidate finding against the
  diff (Q6a), combines the findings with the gate results, and writes the **review record**, identified
  by its review id and selected by its owner (the tenant, and the vertical where there is one; for
  a phase-1 review of one of Substrat's own branches, the platform's own staff subject, Q8), the
  source archive's digest, the base archive's digest, the checklist digest and the model (Q3a A),
  through the one endpoint that accepts it (Q6c). Every surface in Q3 reads that record. It also
  builds the model host (D-59) in platform code, so the usage line is observed rather than
  self-reported — the shape #1073 wants for every model call, which a review
  gets without waiting for it.

None of the four writes to the customer's code, the version record or any scope.

```
                                  ┌──▶ tree ─▶ gate half (container, no credential) ── status, exit code ─┐
  source archive (D5) ─▶ unpacker ┤                                                                      ├─▶ assembler ─▶ review record ─▶ surfaces (Q3)
  base archive (Q3b) ──▶ (no cred)└──▶ diff ─▶ reader half (model host, no exec) ── candidates ──────────┘                    └─▶ promote check (Q4)
                                                     ▲ checklist + procedure @ pinned digest (Q5)
```

## 5. Principles the options are judged against

1. **A clean report must mean something.** A review that did not run, ran out of budget, could
   not see the change, was not sent part of it, or could not run a gate is never shown as clean.
   `skipped`, `incomplete`, `partial` and `blocked` are states of their own, and a review that did
   not run at all still leaves a record saying why, never an absence (the checklist already says a
   gate not run is *not run*, never passed).
2. **The customer's text is data, never instructions.** The change, its comments, its file names,
   its commit messages and anything a customer-owned script prints are written by the party being
   reviewed.
3. **Each part can do one thing.** The unpacker parses and holds no credential, only a read handle to its archives; the gate half executes
   and holds nothing; the reader half reads and executes nothing; the assembler writes one record
   (Q6c).
4. **What blocks is reproducible.** A blocking finding is one anyone can re-run the platform's
   script for and get the same answer (§2.2).
5. **Store the code once.** The source archive is stored with the version (D5), or for a phase-1 branch review
   with its review request (Q8), and nowhere else;
   the record keeps findings, not code.

## 6. Questions, decided

Every question below was decided by the human on 2026-10-18. Each one opens with a **Decided**
line, then keeps what the first revision laid out: lettered options, the recommendation and its
reasoning, what it depends on (or "nothing"), and what it costs if the answer turns out wrong.
Where the decision combines options, the question says the options may be combined. Where the
decision adds to the recommendation, the addition is written into the **Decided** line; where it
departs from it (Q10), the recommendation is kept and marked as not taken.

### Q1 — Metering, the model, and a per-review budget

**Q1a — Which model.**

**Decided: A**, with two additions. A model change ships only after it passes the seeded corpus
(Q7 C), and models are reached through the platform's gateway (Q3e), with no tie to one vendor.
What *passes* means numerically is set by the human at phase 3, with Q7's per-item thresholds;
until then each model change is signed off by the human against the corpus baseline.

- **A. One model, chosen by the platform, pinned per checklist version.** The review record
  names it (Q5b). Changing it is a release of the runner, which ships only once it passes the
  seeded corpus (Q7 C).
- **B. The tenant picks from the catalogue**, as #1054's picker intends for the assistant.
- **C. Bring your own key**, through a tenant connection (#1073's BYOK).
- *Depends on:* C on #1073.
- *Recommendation:* **A.** A finding's quality depends on the model, and Q7's numbers are
  meaningless if every tenant's reviews come from a different one. B and C can follow once the
  numbers exist per model. *If wrong:* tenants with a residency or vendor constraint (D-54: the
  model provider is a disclosed subprocessor the tenant may constrain) cannot use the reader half
  until B or C lands. The jurisdiction rule in Q3d limits the damage: a vertical serving an `eu`
  scope gets no model review rather than a `global` one.

**Q1b — Who pays.**

**Decided: A**, always metered, zero-rated in phases 1–2. The attribution form stays an open
detail for #1073 (below).

- **A. Metered to the tenant** at list price times the platform margin, through the ledger every
  model call already lands in (`ModelUsageLine`, D-59), as a line attributed to the review.
- **B. Included** in a plan, the platform absorbing the cost, metered for our own information
  only.
- **C. A flat price per review**, independent of tokens.
- *Depends on:* the attribution form below waits on #1073.
- *Recommendation:* **A, always metered; zero-rated while the runner is staff-only or invite-only
  (phases 1–2 of Q8).** The ledger line is written from the first review either way, because Q7
  and the budget both need the numbers. Container time is recorded on the review record from the
  first review too, so its cost is known before anyone is billed for it. *If wrong:* A makes a
  large change expensive in a way the tenant did not predict, which Q1c caps; C would hide that but
  needs a price we cannot set without phase-2 data.
- *Open detail either way:* `ModelAttribution` has five fixed keys and requires a `scope`. A review
  has a tenant, a vertical and a version, and no scope. Either the attribution gains a review form
  (a change to a frozen five-key shape whose fixed width exists for provider metadata limits), or
  the review is attributed to a platform-owned sentinel scope per tenant. This needs deciding with
  #1073's platform-side model host, not here.

**Q1c — A per-review budget, and what happens on overspend.** The options may be combined.

**Decided: A and B together, never C**, plus a per-tenant spend limit checked before each call.
A review over budget is never shown as clean.

- **A. Refuse before the call.** Estimate the input from the change's size before anything is
  sent; a change over the cap is recorded as `skipped: too large`, with the size, and the gates
  still run.
- **B. Cap during the call.** A hard output and step bound; a review that hits it is recorded
  `incomplete`, with the items it did not reach listed.
- **C. Allow and bill.**
- *Depends on:* nothing; the spend limit's numbers come from Q1b's metering.
- *Recommendation:* **A and B together, and never C.** Plus a per-tenant spend limit enforced
  in the model host's `guard` before each call (#1054 §5), so a tenant's reviews cannot spend past
  what its admin set. The `guard` seam exists and nothing passes one today; the runner would be its
  first platform-side user. The gate half has its own caps (Q6c). An `incomplete` or `skipped`
  review is never shown as clean (§5.1). The numbers are set from phase-1 data, not here. *If
  wrong:* a cap set too low turns most real changes into `skipped`, which reads as a broken
  product; too high, and a vendored dependency committed by mistake costs real money. Phase 1
  exists to find the number.

### Q2 — The enable surface

**Decided: C.** A staff-granted entitlement makes the runner available to a tenant, and a tenant
owner or admin turns it on per vertical. Every change of state is recorded with who made it and
when. Turning it off stops new reviews and deletes nothing. The entitlement becomes plan-shaped
once reviews are billed (phase 3). **The review entitlement key must not be one a tenant can grant
itself**, by any path; only staff grant it, and later the plan. #2388 tracks the structural fix:
entitlement keys namespaced by the vertical that declares them.

*For a listed vertical (Q4). Derived, for the human to confirm; not one of the human's
answers:* once the promote gate is mandatory at admission, the review
entitlement is granted by staff as part of admission, and the owner's per-vertical switch does not
reach the admission gate: a version submitted for admission is always reviewed, and only a
**completed** review admits it, in the same sense as Q3b's diff base. A `skipped`, `incomplete` or
`partial` admission review leaves the version unadmitted until a completed review exists, because
the owner controls what produces those states (the change's size, the spend limit, the exclusion
globs) and could otherwise step around the gate. The owner sees the version as *awaiting a
completed review*, with the reason from the record, and staff may complete it from admission,
recorded in the record; how, and at whose cost, is part of the phase-3 open item below. What the
owner can still switch off is everything else: reviews of versions that are not submitted for admission
(pushes and previews never promoted to the listed channel) and the optional surfaces, the
pull-request comment (Q3a D) and a published summary (Q10). *Open for phase 3:* who pays for a
review that admission makes mandatory, since the owner cannot turn it off (Q1b).

- **A. Per tenant, by entitlement only.** Staff grant it from the console, like the builder
  studio's entitlement; every vertical of the tenant is reviewed.
- **B. Per vertical, by the tenant.** A switch on the vertical, held by whoever may change its
  settings.
- **C. Both: an entitlement makes it available to the tenant, and a tenant admin turns it on per
  vertical.**
- *Who may turn it on:* whoever may commit the tenant to spend. Today that is the tenant owner
  and admin roles; a vertical's own roles grant nothing here, because the runner is a platform
  service billed to the tenant, not an operation of the vertical.
- *Depends on:* Q1b. Under Q1b B there is no spend to commit, and the switch could sit with
  whoever may change the vertical's settings. And #2388, or an equivalent guarantee, before
  phase 2: until it holds, no tenant may be able to grant the review entitlement to itself, and
  phase 2 does not start.
- *Recommendation:* **C**, with the switch on the vertical's Settings and every change of state
  recorded with who made it and when. Turning it off stops new reviews and deletes nothing.
  Only staff grant the review entitlement through phases 1–2, and no tenant may grant it to
  itself (the requirement in the **Decided** line, #2388). It becomes plan-shaped at phase 3. *If wrong:* A
  alone cannot trial the runner on one vertical of a tenant with many, and charges for all of them;
  B alone leaves staff no lever during the advisory phases. C costs one extra switch.

### Q3 — Where findings are shown when there is no pull request

**Q3a — The surfaces.** The options may be combined; the question is which, and in which order.

**Decided: A, then B, then C; D last and optional per vertical; not the console.** In addition,
the review record is a **first-class platform object with its own API**, and every surface (the
CLI read, the dashboard, the push headline, a pull-request comment) is a view of it through that
API.

- **A. The record and a CLI read.** One review record per review id, selected by (owner
  tenant, vertical or the platform's own staff subject, source digest, base digest, checklist
  digest, model) with the newest first, so a re-review of the same inputs after a runner,
  gate-image or exclusion change is a second record rather than an overwrite; tied to the vertical
  version where there is one, stored platform-side and read through its own API, and a CLI verb (`substrat review
  <version>`, or a field on `substrat versions`) that prints it as text, so an agent driving the
  CLI reads findings without a browser. Every other surface reads the same record through the same
  API; none holds its own copy.
- **B. The dashboard**, on the version in the Deployments tab: the headline (`n blocking, m
  advisory`, or `skipped`/`incomplete`/`partial`), the gates run, and the findings in the
  checklist's own report shape.
- **C. The `substrat push` headline.** Push prints the headline and a link once the review exists.
  The review is asynchronous (the model call takes longer than an upload should wait), so push
  does not wait by default; a flag waits for it and exits non-zero only when Q4 says so. A
  pull-request preview (`substrat preview create`, D-43) is a pushed version like any other and
  gets its record the same way; a deploy workflow on GitHub may copy the headline into its own job
  summary, which is the customer's CI printing our CLI's output, not our runner holding a GitHub
  credential (D2).
- **D. A pull-request comment**, where the repository is linked through the dashboard's GitHub
  App. `upsertPrComment` already keeps one marked comment per pull request. The comment would
  carry the headline and a link, never the findings' quotes, and the dashboard writes it from the
  record, not the runner (Q6c). A convenience for one git host, so nothing may depend on it.
  Where the repository is public, the comment's headline is readable by anyone, so turning D on
  for a vertical counts as the owner publishing its pass/fail summary (Q10 D); the link opens the
  record only for Q10's readers.
- Not offered: **the console as a findings surface.** Staff see the review's state (ran, skipped,
  cost), not its findings; Q10 covers staff access.
- *Depends on:* A and C need D5's upload in the CLI; without source there is nothing to review.
- *Recommendation:* **A, then B, then C; D last and optional per vertical.** *If wrong:* building B
  before A leaves an agent that pushes (the case the runner exists for) with nothing to read;
  building D first makes GitHub the real surface, which D2 set out to avoid.

**Q3b — What is stored, and for how long.**

**Decided: A, without C**, as recommended below: archive and record kept while anything serves
the version, then 180 days (30 days from the push for a version nothing ever served). The record
holds findings, digests and run metadata (the fields listed under *The record* below), and no
transcript and no prompt. Two exceptions to "no archive without review" are listed under *When an
archive is stored*: an admission-mandated review, and a phase-1 branch review.

Two things are stored: the **source archive** (D5), which must exist from the push until the
asynchronous review has run and which later reviews diff against, and the **review record**.

What every option shares:

- *When an archive is stored:* only for a vertical with review enabled (Q2), until the controlled
  build (D5 C) makes the archive the build input for every vertical. A push to a vertical without
  review uploads no archive, with two exceptions:
  - *A listed vertical, once the promote gate is mandatory at admission (Q2, Q4):* the CLI
    uploads the archive with **every push** of the listed vertical, whatever the owner's switch
    says, so a version submitted for admission later already has one; it is reviewed on
    submission.
    Its record is read as Q10 says (the owner tenant's own team and the pushing credential), and
    the archive and record are kept by the rules below like any other.
  - *A phase-1 review of one of Substrat's own branches (Q8):* the branch archive and its base are
    stored on staff upload, with their digests recorded in the review request, and are kept 30 days
    from the review, then deleted; staff may delete them earlier.
- *Where:* the archive's store is placed at upload, by the jurisdiction rule of Q3d evaluated at
  upload. If no placement satisfies it, no archive is stored and the version's record says
  `skipped: no placement in jurisdiction`. If jurisdiction is stricter at review start than at
  upload, the review does not run, the archive is deleted, and the record says
  `skipped: jurisdiction changed since upload`.
- *The diff base:* the archive of the last reviewed version of the same vertical, where
  *reviewed* means a review that completed: not `skipped`, not `incomplete`, and not `partial`
  through a customer exclusion. A known cost: a vertical with a standing customer glob never
  produces such a review, so every review it gets is full-tree (Q1b, and Q1c's `skipped: too
  large`). If that archive
  has expired, or there is none, the review is a full-tree review and the record says so (`base:
  none, full tree`).
- *The record:* each finding (item, severity, confirmation, `file:line`, a bounded quote,
  fails-when, fix), each gate's name, status and exit code, the checklist digest, the model spec,
  the runner version, the archive digest and the base archive's digest, every path exclusion in
  force and the files it kept from the reader half (Q3c), the token counts and container time. Not
  the prompt; the diff is recomputed from the two archives while both exist. A
  review that did not run still writes a record, with the reason (§5.1). The record lives in a store
  of its own (not the #1748 findings store, whose findings are recurring and fingerprinted rather
  than tied to one version) and shares the archive's retention.
- *Deletion:* both are deleted when the vertical is deleted and when the tenant is reaped (#36).

The options differ in how long the archive and the record are kept. Channel history is append-only
and is removed only with the vertical, so "while the version is in channel history" never ends. A
version can also be served with no channel pointing at it, through a scope pinned to it or a preview
bound to it. So the window is measured from the moment **nothing serves the version**: no channel
points at it, no scope is pinned to it and no preview is bound to it.

- **A. A window after the version stops being served.** Kept while anything serves the version,
  and for 180 days after the last channel pointer, scope pin or preview binding goes (the window
  the platform already uses for issues and findings). A version nothing ever serves — a push never
  promoted, bound or previewed — is kept for 30 days from the push, unless something comes to serve
  it within that time, in which case the first rule applies from then on.
- **B. For the life of the version.** Kept until the vertical is deleted or the tenant is reaped,
  so every version a channel ever served can still be diffed, rebuilt (once C exists) and shown
  with its review.
- **C. A or B, plus the model's full transcript**, for debugging the runner. May be combined with
  either.
- Not offered: deleting the archive as soon as its review has run. The next review would have no
  base, and C nothing to build from, which conflicts with D5.
- *Depends on:* Q2 (which verticals store archives), Q3d (placement). C would feed Q7's corpus;
  without it the corpus grows only through opt-in cases.
- *Recommendation:* **A, without C.** The record's usage line follows the model ledger's own 400
  days, like every other model call. Quotes are bounded (one line, a fixed character cap) and pass
  the same redaction step the assistant RFC proposes for tenant text before they are stored; a quote
  that survived redaction is erased with its record under subject erasure, since a record has no
  other copy. *If wrong:* under A, a rollback to a version unserved for more than 180 days finds no
  archive, so its review cannot be shown or its tree rebuilt, and the next review is full-tree; B
  avoids that at the cost of holding every served version's source for the vertical's whole life.
  Without C we cannot re-read the model's reasoning behind a disputed finding, only the finding and
  the code; choosing C later is a policy change tenants must be told about.

**Q3c — Path exclusions: what the reader half is not sent.**

The change is the customer's source code, which can contain personal data: seed files, test
fixtures, a persona list, a sample import. Sending it to a model provider is a disclosure to a
subprocessor (D-54).

**Decided: C**, with the two rules of the recommendation below, and **every path exclusion is
recorded in the review record itself**: each platform rule and each customer glob in force, and
the files it kept from the reader half.

- **A. Send the diff as it is**, to a provider listed as a subprocessor.
- **B. A, minus platform-defined exclusions**: lockfiles, binary files, generated files and files
  over a size cap, recorded as `not sent` in the record.
- **C. B, plus customer-declared exclusions** (seed and fixture globs), set by a tenant admin on
  the vertical's Settings, not in the pushed tree.
- *Depends on:* Q2 (who holds the vertical's review settings).
- *Recommendation:* **C**, with two rules. An exclusion narrows only what the **reader half** is
  sent; the gate half always gets the full tree. And any file excluded by a customer-declared glob
  makes the review `partial`, shown in the headline with the globs in force, never clean (§5.1).
  Redaction of secrets and contact data applies to what is **stored** (the quotes), not to what is
  sent: redacting source before a reviewer reads it changes the code under review, and S7 (secrets)
  is exactly an item that needs to see a hard-coded token to report it. *If wrong:* C's exclusions
  mean a personal-data field added in an excluded seed file is not seen by the reader half; S5 on
  the model file still is, which is where the classification lives.

**Q3d — Jurisdiction (K-32).**

**Decided: B**, as recommended below.

- **A. The reader half follows jurisdiction; nothing else does.**
- **B. Every part that processes the code follows it**: the archive's and the record's store, the
  gate container, and the reader half's provider route.
- *Depends on:* the regional placements that exist (§9).
- *Recommendation:* **B.** Jurisdiction is recorded per scope, and a review has no scope, so it
  takes every jurisdiction among the scopes the vertical serves, preview scopes included. It is
  evaluated **at upload** for the archive's store (Q3b) and again **at review start** for the
  gate container and the provider route, and the record stores the jurisdictions it ran under. A
  part runs only where a placement satisfies every one of those jurisdictions at once; a vertical
  serving both `eu` and `us` scopes needs a placement that satisfies both, and where none exists
  that part is skipped and recorded. A reader half
  without one is `skipped: no provider in jurisdiction`, never a silent `global` route; a store or
  gate container without one means the review does not run, recorded as
  `skipped: no placement in jurisdiction`. A scope added later does not move a completed record;
  the next review is evaluated afresh. *If wrong:* A keeps the provider in region while the code
  itself is stored and executed elsewhere, which is the inconsistency D-53 was written against.

**Q3e — The model path and provider retention.**

**Decided: A**, as recommended below; it is also Q1a's "reached through the platform's gateway".

- **A. The HTTP gateway row only.** It sends `cf-aig-collect-log-payload: false`, so the gateway
  logs counts and cost and not the prompt.
- **B. Any path the model host supports**, including the `env.AI` binding, which names no gateway
  (D-59) and so carries no payload-log setting.
- *Depends on:* Q1a (the model chosen must be reachable on the path).
- *Recommendation:* **A.** Either way, a provider's own operational retention (abuse monitoring)
  applies unless zero retention is contracted for this traffic, and the provider is listed as a
  subprocessor with its retention stated. *If wrong:* B makes "the gateway keeps no prompt" untrue
  for some reviews, with nothing in the record to say which.

### Q4 — May a finding gate `substrat push`

The rule from D4 holds in every option: **only a script-confirmed finding of blocking severity
may block**, where *script-confirmed* means §2.2's conditions held (confirmed as Q6d). A
customer-owned script's result is reported and never blocks.

**Decided: B. Promotion is gated, never the upload**, on script-confirmed blocking findings
only, and not before the controlled build (D5 C, phase 4); until then nothing blocks. The gate is
opt-in per vertical and off by default at first. Once Q7's per-item thresholds are met it becomes
**mandatory at staff admission for listed verticals** (Q2 says what that does to the entitlement
and the owner's switch). A private vertical's owner may override a refusal with a
recorded reason; a listed vertical's override belongs to staff admission.

- **A. Never.** The review is advisory forever; blocking stays with the CLI's own gates (#955)
  and with admission for listed verticals.
- **B. Gate promotion, not upload.** A version with an open script-confirmed blocking finding
  uploads, previews and can be reviewed; `substrat push --promote prod` and the dashboard's
  promote refuse it, naming the finding. The promote dialog's `PromotionReview` is where the
  dashboard already shows what a promote is about to change, so the refusal and the override
  belong there. A private vertical's owner may override with a recorded reason, written to channel
  history beside the promote; a listed vertical's override is staff admission's, not the owner's.
  Only that recorded override clears the refusal: an owner marking the finding *not a problem*
  (Q7 A) is feedback, never an override.
- **C. Gate the upload.** Push waits for the review and refuses on a blocking finding.
- *Depends on:* D5's controlled build (C), which is phase 4's precondition; Q6d (which gate results
  are platform-owned); and Q7's per-item thresholds.
- *Recommendation:* **A until phase 4; then B, opt-in per vertical, default off.** Never C: the
  review is slower than an upload, a preview is how a builder sees the problem, and refusing the
  upload removes the one place the finding is easiest to act on. (The decision keeps this and
  adds the step for listed verticals: once Q7's per-item thresholds are met, admission requires
  the gate rather than offering it.)
- *Why blocking waits for the controlled build, even for a private vertical:* under D5's upload
  the source and the bundle arrive side by side, so a finding is about the uploaded tree, which can
  differ from what runs for ordinary reasons (an uncommitted local edit, a build step that
  generates code). A refusal must be about the code that will be promoted. The controlled build
  makes the two the same.
- *Why an owner override is still enough for a private vertical:* once the finding is about the
  code that will run, D-36 decides who may accept it: a private vertical's only audience is its own
  tenant, so its owner may accept a known risk on the record. For a listed vertical the audience
  is wider, and a human at admission holds the override.
- *If wrong:* letting anything but a platform-owned script block means a model's mistaken finding
  stops a production deploy, and text planted in a change (in a vendored dependency, say) can
  create a blocking finding and stop a deploy. Gating on platform-owned scripts only removes both.
  The other cost runs the opposite way: under §2.2, possibly **only boundary-lint qualifies**
  (S1), because the gates behind S2–S6 load the vertical's code or read inputs the vertical
  supplies. Choosing B therefore may mean S1 alone can refuse a promote, with every other item
  advisory however severe; B is not a promise that S2–S6 will block.

### Q5 — Keeping the local and hosted runners on one checklist

**Decided: Q5a A, Q5b A, Q5c A, Q5d A**, as recommended below, plus one addition: **every
checklist version is immutable and stored**, keyed by its digest, so an old review record can be
re-read against the rules it was produced under.

**Q5a — How the hosted runner gets the file.**

- **A. Bundled from this repository at the runner's build**: the runner's source imports
  `plugin/substrat/review/checklist.md` as text, so the deployed runner holds exactly the file at
  the commit it was built from. No copy exists to drift.
- **B. Fetched at run time from the published plugin**, at a pinned plugin version.
- **C. Read from the customer's repository** (their copy of the plugin, or a checklist they ship).
- *Depends on:* nothing.
- *Recommendation:* **A.** It satisfies D1 with no copy and no generated file, so it needs none of
  the three marks of a generated artifact. B adds a network dependency and a second source of
  truth (whatever the registry serves). **C is rejected**: the rules a change is reviewed against
  must not come from the change. *If wrong:* a checklist edit reaches the hosted runner only when
  the runner is redeployed; that is a release step, and Q5b makes it visible.

**Q5b — Versioning, and what a record pins.**

- **A. A content digest**: one sha256 over the bytes of the checklist followed by the bytes of the
  procedure, in that fixed order (under Q5c A; under Q5c B, over the checklist alone), computed at
  build, plus the plugin version it shipped in. Elsewhere in this RFC, "the checklist digest" means
  this one digest.
- **B. A hand-kept version field** in the checklist.
- *Depends on:* Q5c (whether the procedure is inside the digest).
- *Recommendation:* **A.** A hand-kept version is a field that exists only to go wrong (the same
  reason `docs/` has no `updated:` field). Both runners print the digest in the report's headline,
  so a local report and a hosted record can be compared at a glance, and a builder whose local
  plugin is older sees that the two reviews used different rules. A review record pins: that one
  digest and the plugin version, the runner's own version, the model spec,
  the gate image's version, and the archive digests (D5). The checklist and procedure text behind
  each digest is stored once and never changed, so the digest a record pins always resolves to the
  rules it names. *If wrong:* without a digest, a finding cannot be tied to the rule text that
  produced it, and Q7's per-item numbers mix rule versions.

**Q5c — The procedure.** The local skill's procedure (find the change, run gates read-only, read,
disprove, report) is written in `SKILL.md`, not in the checklist.

- **A. Move it beside the checklist** (`plugin/substrat/review/procedure.md`, or a section of the
  checklist), have the skill point at it as it points at the checklist, and include it in Q5b's
  digest, after the checklist. The hosted runner's prompt is then the checklist, the procedure, the diff and the gate
  results, and nothing else.
- **B. Leave it in the skill**, and have the hosted runner keep its own procedure.
- *Depends on:* nothing.
- *Recommendation:* **A.** *If wrong:* under B the two runners drift on procedure while sharing the
  rules: the hosted one stops disproving its candidates, say, and its false-positive rate rises
  for a reason Q7 cannot see.

**Q5d — Which items the model reads.**

- **A. The checklist says.** Each item, or each part of an item, carries the `judgement` mark the
  gates work (D3) introduces, and the runner asks the model about exactly those.
- **B. The runner keeps its own list** of items to send to the model.
- *Depends on:* the gates work (D3) adding the mark.
- *Recommendation:* **A.** B is a second copy of a fact about the rules, which D1 forbids; it
  would also let the two runners disagree about which items a model reads. The local runner, which
  is itself a model, reads every item but reports a script item through its gate (as the checklist
  already instructs), so the mark changes nothing locally. *If wrong:* an item that loses its gate
  and keeps no mark is read by neither half, silently; Q8's phase-0 exit condition (every item is
  a gate or marked `judgement`) is what refuses that.

### Q6 — Trust and abuse

**Decided: Q6a A, Q6b A, Q6c A** (B only as the state before the container exists), as
recommended below, and **Q6d A** (§2.2 confirmed as written).

The change, and anything a customer-owned script prints, is text the reviewed party controls.
Q6a–c each offer **A, the structural set listed**, or **B, a narrower set** (named in the
sub-question) that ships sooner; the cost of B is the gap it leaves.

**Q6a — Prompt injection.**

- **A. All of:**
  1. The reader half has **no tools that act**: no write, no network, no shell, no credential. It
     returns text, parsed into a strict finding schema; anything that does not parse is dropped
     and counted.
  2. **Every candidate finding is checked by the assembler**: its `file:line` must exist in the
     diff and its quote must match that line. A finding that fails is dropped. The model cannot
     cite code that is not there.
  3. The model's output **never decides a gate** (D4, Q4).
  4. The checklist, procedure and system instructions are platform-held (Q5a). The diff is passed
     as delimited data and described as untrusted in the instructions.
  5. **Gate output is the same kind of data.** The reader half receives each gate's name, status
     and exit code. Where it also receives output text (a type error, a failing test's message),
     that text is delimited and marked untrusted under the same rules as the diff, bounded in
     size, and never quoted into a finding unless the quote also matches a line of the diff.
  6. Text in the change that addresses a reviewer is itself reported as an advisory finding
     outside the checklist.
- **B. 1–4 only.** Leaves gate output as an unmarked channel into the reader.
- *Depends on:* nothing.
- *Recommendation:* **A.** *The stated limit:* a reader can be talked out of a `judgement` finding.
  That is why those findings are advisory by construction, and why no gate depends on the reader.

**Q6b — What must hold so that findings are not suppressed or forged.**

| Concern | What must hold |
|---|---|
| The rules | The runner never reads the customer's copy of the checklist (Q5a). |
| Instructions in the change or in gate output | Q6a. |
| A gate result influenced from inside the tree | §2.2: the platform's own tool and inputs, text gates before customer code runs, an install the project does not configure, verdicts by observed exit status, no customer code in the verdict's process, no write credential in the gate environment. **This is the precondition for any blocking**: without it a result is customer-owned and cannot block under Q4. |
| A gate configuration or allow-hatch added or widened by the change | Reported as its own finding, never read as clean for the rule it affects (§2.2, condition 2). |
| The archive itself | The unpacker's extraction rules and bounds (§2.2), with no credential. |
| A boundaries gate run through a project script | The runner's pinned boundary-lint, never `npm run lint:boundaries` (§2.2, condition 1). |
| The uploaded tree differing from the deployed bundle | D5's controlled build before phase 4; until then no finding blocks. |
| A bad change split across many pushes | The diff base is the last **reviewed** version's archive (a review that completed, with no skip and no customer exclusion; Q3b), not the last pushed one; a full-tree review can be requested. |
| A change too large to review | `skipped: too large`, never clean (Q1c). |
| Customer-declared exclusions covering source | The review is `partial`, with the globs shown (Q3c); the gate half still gets the full tree. |
| The runner turned off | The switch is recorded (Q2). For a listed vertical, admission sees that the version has no review; once the gate is mandatory at admission, the switch does not reach a version submitted for admission, which is always reviewed (Q2, Q4). |

- **A. Every row above.**
- **B. Every row except the controlled build**, which is D5's and already scheduled.
- *Depends on:* D5's controlled build (C) for the bundle row; Q6d for the gate rows.
- *Recommendation:* **A**, which with D5 decided means the rows are requirements of their phases
  (Q8).

**Q6c — Credentials, isolation and blast radius.**

- **A. All of:**
  - **What may be read:** the unpacker reads the review's archive and its base archive; the gate
    half reads only the tree the unpacker extracted for this review; the reader half reads
    the diff, the checklist and procedure, and the gate half's results. Nothing in any scope: no
    tenant data, no vertical secret or env value, no other vertical's code, no other tenant's
    anything.
  - **What each part holds:** the unpacker holds no credential; its read access is a single-use
    handle to the two archives, issued per review and expiring with it (§2.2). The gate half holds nothing; its tree is
    handed to it by the unpacker. The reader half never sees a model
    credential: the assembler's model host makes the call. Only the **assembler** holds a write
    credential, to one endpoint that accepts one review record for the review id it was issued,
    once.
  - **What nothing in the runner may do:** promote, admit, bind, roll back, comment on a pull
    request, push to a repository, or acknowledge a checkpoint. Q4's promote check reads the
    record; the runner does not act on it.
  - **Isolation:** the gate half runs in a disposable container per review, addressed by the
    **review id** and never by a tenant or vertical id, so no two reviews share one; it has no
    platform credential in its environment, network only to the package registry during the
    install step, and wall-clock, CPU, memory, disk and process caps, after which the review is
    `incomplete` for the gates not reached. It is discarded after the run.
  - **No mixing between tenants:** each review is a fresh model context, and no request carries
    two tenants' code. Nothing on the model path caches responses; a provider prompt cache, where
    used, covers only the platform-held prefix (checklist and procedure), which is the same for
    every tenant.
- **B. A without the container** for customer changes: only the gates that execute none of the
  customer's code and need no install run — which excludes boundary-lint's engine-ownership rule
  when engines are declared (§2.2, condition 3) — and everything else is `not run`.
- *Depends on:* the container's cost and placement (§9); Q3d.
- *Recommendation:* **A, with B as the state before the container exists.** Phase 1 reviews only
  our own code (our demo verticals and branches of this repository whose content a maintainer
  authored or reviewed, Q8), so its gate half may run without a container, still holding no
  credential. That holds **only** because a maintainer authored or reviewed the input: a pull
  request from outside or from a fork, and a dependency-bot or automation branch before a
  maintainer has reviewed it, is never reviewed by a gate that loads the tree's code outside the
  container, and **the container is a precondition of any other input**, the first customer's
  review (phase 2) included.
  *If wrong:* a gate
  half that holds any credential gives code in the reviewed tree that credential's reach; there is
  no "mostly isolated" version of this.

**Q6d — Confirm §2.2.**

**Decided: A.** The seven conditions and the extraction rules of §2.2 are the requirement for any
blocking. Only a gate that meets all of them counts as script-confirmed, which at first may be the
boundaries gate (S1) alone. §2.2 is therefore decided, no longer proposed.

- **A. Confirm §2.2 as written**: a gate result is platform-owned only when all seven conditions
  and the extraction rules hold.
- **B. Confirm it with named exceptions**, each one a gate the human accepts as platform-owned
  without meeting every condition, with the reason recorded.
- **C. Reject it**, keeping D4's "a script confirmed it" without further conditions.
- *Depends on:* nothing; Q4 and Q6b depend on it.
- *Recommendation:* **A.** *If wrong:* B or C lets a result that the reviewed tree could influence
  count as confirmation, which is the one kind of finding D4 lets block.

### Q7 — False-positive tracking before anything becomes required

The options may be combined.

**Decided: all three, the corpus first.** The seeded corpus (C) is **kept running after the gate
is required**: it is re-run on every model or checklist change and keeps measuring misses, which
is how a blind runner is told from a quiet one. Script-confirmed findings are expected to have no
false positives; one that does is a gate bug, fixed in the gate. The human sets the per-item
thresholds at phase 3.

- **A. Owner feedback.** Each finding can be marked *fixed*, *not a problem* (with a reason) or
  *won't fix*, from the dashboard or the CLI. Feedback never clears a promote refusal (Q4 B).
- **B. An automatic signal.** A finding whose quoted line changed in the next reviewed version
  counts as probably fixed; one that survives unchanged through several versions with no feedback
  counts as probably ignored.
- **C. A seeded corpus.** Our own demo verticals' history plus a set of known-bad changes, one or
  more per checklist item, run on every runner, model or checklist change, measuring both false
  positives and misses. It keeps running after any item's gate is required, and a model change
  ships only once it passes (Q1a).
- *Depends on:* Q3b (B's transcripts would feed the corpus).
- *Recommendation:* **all three.** C first, because it needs no customer and is the only one that
  measures misses. Numbers are kept per (item, checklist digest, model), aggregated, with no code
  content. The bar before Q4 B may be offered, or required at admission, for any item is a published threshold per item (for
  example, a minimum number of reviews over at least four weeks, with the share marked *not a
  problem* under a stated ceiling); the human sets the numbers at phase 3. For script-confirmed
  items the expectation is no false positives at all: one is a gate bug, fixed in the gate. *If
  wrong:* without A, the runner cannot learn which items annoy; without C it cannot tell a quiet
  runner from a blind one.

### Q8 — Rollout

**Decided: A**, with one addition: phase 1 also reviews **Substrat's own changes** (dogfooding).
That means branches of this repository whose content a maintainer authored or reviewed; never a
pull request from outside or from a fork, and never a dependency-bot or automation branch without
a maintainer's review (Q6c). A review is triggered by staff through the same intake a customer
uses, a CLI upload of the branch's tree (D5 A), and not by a workflow in this repository (D2, §8).
Such a review has no tenant, vertical or version, so:

- *its record* is owned by the platform's own staff subject and selected like any other (§4, Q3a
  A); it is read by the maintainers who triggered it, through the CLI. That is not a staff findings
  view: staff still get none of a customer's record (Q3a, Q10);
- *its diff base* is the archive of the branch's merge-base with `main`, uploaded the same way, or
  none, in which case it is a full-tree review;
- *its retention*: the archives and the record are kept 30 days from the review and then deleted,
  and staff may delete them earlier; nothing serves them, so Q3b's serving window never applies;
- *its cost* is the platform's own, zero-rated like the rest of phase 1.

- **A. The phases below.**
- **B. The phases below without phase 1**, starting with invited tenants.
- *Depends on:* D5 (the controlled build before phase 4), Q6c (the container before phase 2),
  #2388 or an equivalent before phase 2 (Q2), Q7
  (thresholds before phase 4).
- *Recommendation:* **A.**

| Phase | Who | What runs | Exit when |
|---|---|---|---|
| 0 | — | This RFC answered; the `judgement` marks and the gates work (D3) landed; the checklist digest printed by the local skill; the CLI uploads the source archive (D5 A). | Every checklist item is either a gate or marked `judgement`. |
| 1 | Staff, on our own demo verticals, the seeded corpus and branches of this repository a maintainer authored or reviewed (uploaded by staff through the CLI, kept 30 days) | Gates under §2.2, without a container (maintainer-authored or -reviewed input only, Q6c), holding no credential; reader half on one model; records stored; CLI read only. Zero-rated. | Q1c's caps set from real numbers; Q7 C has a baseline per item; the container gate half works; #2388 or an equivalent holds, so no tenant can grant itself the review entitlement (Q2). |
| 2 | Invited tenants, by staff-granted entitlement | Advisory only. Record, CLI read, dashboard, push headline. Container gate half from the first customer review. Metered, zero-rated. | Owner feedback (Q7 A) over at least four weeks; cost per review known, model and container. |
| 3 | Any tenant that enables it | Advisory only. Metered and billed (Q1b). Plan-shaped entitlement. | Per-item thresholds published; **the controlled build (D5 C) builds the bundle from the uploaded archive**. |
| 4 | Opt-in per vertical, default off; mandatory at staff admission for listed verticals once Q7's per-item thresholds are met | Q4 B: script-confirmed blocking findings refuse promote on versions the platform built, with a recorded owner override for a private vertical and staff admission's for a listed one. Possibly only S1 (boundary-lint) can refuse; every other item stays advisory (§2.2, Q4). The seeded corpus keeps running (Q7). | — |

*If wrong:* B puts unmeasured caps in front of a customer; skipping phase 2's advisory window makes
Q4's threshold a guess.

### Q9 — Decided

Where the reviewed change comes from is decided: §2, D5.

### Q10 — Who may read a review record

**Decided: D**, which the first revision did not offer and which replaces its recommendation (C).
A record is read by the **owner tenant's roles that may already see source-bearing views** of the
vertical, and by the **credential that pushed the version**. *Source-bearing views* means the views
that already show the vertical's own source, today the version's migration SQL; the audience is
the one that can read it today, the vertical's own team in the owner tenant, and nobody else. Installers of a listed vertical see at
most a pass/fail summary, and only one the owner chooses to publish. The reason: the findings
quote source, and a listed vertical is readable by every tenant that installs it, so a rule keyed
on who may see the vertical (A, C) would reach past its owner. It is the same
rule that keeps a version's migration SQL readable only by the vertical's own team.

- **A. Anyone who may see the vertical's versions** in the dashboard.
- **B. Tenant owners and admins only.**
- **C. A, plus the CLI credential that pushed the version.**
- **D. The owner tenant's roles that may see source-bearing views, plus the pushing credential;**
  installers of a listed vertical get at most an owner-published pass/fail summary. *(Decided.)*
- *Depends on:* the pushing credential's read (C, D) needs D5's upload in the CLI. D's
  owner-published pass/fail summary is not built; until it exists, installers see nothing of a
  review. The pull-request comment (Q3a D) is the one way an owner publishes the headline before
  then.
- *Recommendation (first revision, not taken):* **C.** The findings quote the tenant's own code,
  so anyone who may already see that vertical's deploys may see them; the pushing credential must
  read them for the agent case (Q3a). The decision keeps the pushing credential and narrows "may
  see the deploys" to the owner tenant's source-bearing views, because for a listed vertical those
  are not the same set.
- *Either way:* a record owned by the platform's own staff subject (a phase-1 review of one of
  Substrat's own branches) is read by the maintainers who triggered it (Q8).
- *Either way:* staff are not given a findings view (Q3a). A staff read of a record, for a support
  case or otherwise, is recorded in the access log (K-24) only if the record's store is read through
  the same logged path as the directory; that is a requirement on the store, not something it gets
  for free.
- *If wrong:* B hides findings from the builder who has to fix them; D keeps them with the builder
  and the pushing agent. D's cost is that an installer judging a listed vertical sees no more than
  the owner publishes, which is why admission (Q4) and not the installer is where a listed
  vertical's review is enforced.

## 7. Decided answers, in one table

All decided by the human on 2026-10-18, except Q9 (decided earlier, D5).

| Q | Topic | Decided | Depends on |
|---|---|---|---|
| Q1a | Which model | A: one platform-chosen model, pinned per checklist version; a model change ships only after it passes the seeded corpus (criterion set by the human at phase 3; until then human sign-off against the baseline); reached through the platform gateway, no vendor tie | C on #1073 |
| Q1b | Who pays | A: metered to the tenant through the model ledger; zero-rated in phases 1–2 | attribution form on #1073 |
| Q1c | Per-review budget | A + B: refuse before the call, hard cap during it; per-tenant spend limit in the guard; over budget never shown as clean | nothing |
| Q2 | Enable surface | C: staff-granted entitlement per tenant, switch per vertical held by tenant owner and admin; every state change recorded; off deletes nothing; plan-shaped once billed; the key is never one a tenant can grant itself; for a listed vertical the admission gate is outside the owner's switch and only a completed review admits (derived, for the human to confirm; who pays for it open for phase 3) | Q1b; #2388 or an equivalent before phase 2 |
| Q3a | Surfaces | A, then B, then C; D last and optional (turning it on publishes the headline); not the console. The record is a first-class platform object with its own API, identified by review id and selected by owner, source digest, base digest, checklist digest and model; every surface is a view of it | A and C on D5 |
| Q3b | Stored and retention | A: archive only where review is on (plus every version submitted for a mandatory admission review, and phase-1 branch archives kept 30 days), placed at upload; kept while anything serves the version (channel, scope pin or preview), then 180 days (30 days from push if never served); findings, digests and run metadata, no transcript or prompt; diff base the last completed review, full tree once it has expired; every non-run recorded | Q2, Q3d |
| Q3c | Path exclusions | C: platform and customer exclusions, each recorded in the review record; customer globs make a review `partial` | Q2 |
| Q3d | Jurisdiction | B: every part follows it; evaluated at upload and at review start | regional placements (§9) |
| Q3e | Model path | A: the HTTP gateway row only | Q1a |
| Q4 | Gating | B: gate promotion, never upload, on script-confirmed blocking findings only, from phase 4 (after the controlled build); opt-in per vertical, default off, then mandatory at staff admission for listed verticals once Q7's per-item thresholds are met; recorded owner override for a private vertical, staff admission's for a listed one; possibly only S1 can block | D5 C, Q6d, Q7 |
| Q5a | Checklist source | A: bundled from this repository at build | nothing |
| Q5b | Versioning | A: content digest plus plugin version, printed by both runners; every checklist version immutable and stored | Q5c |
| Q5c | Procedure | A: move it beside the checklist and into the digest | nothing |
| Q5d | Which items the model reads | A: the checklist's own `judgement` mark | D3's mark |
| Q6a | Prompt injection | A, including gate output as untrusted data | nothing |
| Q6b | Suppression and forgery | A: every row; §2.2 is the precondition for any blocking | D5 C, Q6d |
| Q6c | Credentials and isolation | A; B only before the container exists, and only for input a maintainer authored or reviewed; the container before any other input | §9, Q3d |
| Q6d | Confirm §2.2 | A: confirmed as written; only gates meeting all seven conditions are script-confirmed | nothing |
| Q7 | False positives | A + B + C; corpus first and kept running after the gate is required; zero false positives expected of script-confirmed findings; per-item thresholds set by the human at phase 3 | Q3b |
| Q8 | Rollout | A: phases 0–4, the controlled build before phase 4; phase 1 also reviews branches of this repository a maintainer authored or reviewed, uploaded by staff through the CLI, kept 30 days | D5, Q6c, #2388 or an equivalent, Q7 |
| Q9 | Source of the change | D5: A (upload with the push) for phases 1–3, then C (controlled build); B dropped | — |
| Q10 | Who reads a record | D (changed from the recommended C): the owner tenant's roles that may see source-bearing views (the audience of the version's migration SQL), plus the pushing credential; installers of a listed vertical see at most an owner-published pass/fail summary (not built); staff reads access-logged, if the record's store is read through the logged path | D5 |

## 8. Not proposed

- **No GitHub Actions job and no model key in this repository or in a customer's CI** (D2).
- **No model finding ever blocks** (D4). Nothing here proposes a confidence threshold above
  which a model's finding becomes blocking.
- **No review of the built bundle.** It is minified output; review reads source or nothing.
- **No runner-specific rules.** A rule the hosted runner needs goes into the checklist, where the
  local runner reads it too.
- **No runner credential on the customer's git host.** The one write to a git host this RFC
  allows is the dashboard's existing pull-request comment, made from the record (Q3a D).
- **No change** under the excluded areas: the control plane's connection and email routes, the
  connect-round code, the social relay, the WfP upload path.

## 9. Unverified

- **Container cost, start time and regional placement per review.** The builder studio runs
  `ContainerWorkspace`; no figure for a short-lived per-review container, and no record of where
  one can be placed by jurisdiction, is in the repository. Q3d B and Q6c depend on both.
- **Which checklist gates can be platform-owned at all** under §2.2. Possibly boundary-lint alone
  (S1), and its engine-ownership rule only with engines from platform-verified packages; the
  compiler gate only with platform options and types; and none of the gates that load the
  vertical's code as they are built now. Q4 B's reach depends on the answer.
- **Which gates run in a scaffolded project without the monorepo** under §2.2. The checklist says a
  scaffolded project has three (`lint:boundaries`, `typecheck`, `test`); the builder-workspace
  runner names eight. Which of the eight can run from the platform's own image against an external
  vertical's tree is not established.
- **Provider routes per jurisdiction** for the model Q1a would pick: not recorded here, and the
  assistant RFC lists the same gap.
- **Which jurisdiction a review takes** (Q3d). Every jurisdiction among the vertical's scopes is
  decided (Q3d B); nothing in the repository yet decides jurisdiction for code rather than data,
  so whether a placement exists for each combination is unestablished.
- **Whether `ModelAttribution` can take a review without a scope** (Q1b) without breaking the
  five-key limit's reason: unexamined.
- **The archive format and the controlled build's input contract** (D5): to be designed together,
  so the archive phase 0 uploads is the one phase 3 builds from.

## Alternatives rejected

- **A GitHub Actions job with a model key** (#2365's original ask). Ties the runner to one git
  host, puts a model key where every workflow edit can reach it, and meters nothing per customer.
- **Reading the change from the customer's git** (D5 B). Read access is not guaranteed, and it does
  not tie the bundle to the commit.
- **Uploading a diff instead of the tree** (D5). The gates need the whole tree, and a controlled
  build cannot build from a diff.
- **The runner reading the customer's checklist** (Q5a C). The rules a change is reviewed against
  must not come from the change.
- **Model findings blocking above a confidence score.** A model's confidence is another output of
  the same model; it is not a second oracle, and it is as open to injection as the finding.
- **Gate results taken from the customer's own scripts as confirmation** (§2.2). Reported, never
  confirming.
