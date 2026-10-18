---
status: proposed
layer: plan
description: The platform-hosted half of the Substrat review checklist (#2365). Records what is already decided (one runner-neutral checklist, no model key in GitHub CI, mechanical gates first, the model trusted only for judgement items, advisory until a platform-owned script confirms, and the source of the reviewed change — a full-tree upload with the push, later the input of a controlled build) and lays out the open questions with lettered options, a recommended default, what each depends on and the cost of being wrong — metering and model, the enable surface, where findings live and for how long, gating a push, checklist versioning, trust and abuse, false-positive tracking, rollout, and who may read a record.
---

# RFC: the hosted review runner

**Status: proposed. Nothing here is agreed beyond §2**, which records decisions already taken.
It answers the part of [#2365](https://github.com/substrat-run/substrat/issues/2365) that #2368
left open: the hosted runner. It recommends; a human decides. The open decisions are §6,
numbered so they can be answered as `Q1a: A, Q2: C, …`; §7 collects the recommended answers in
one table. Q9 was open in the first revision and has since been decided (§2, D5); its number is
kept so the other answers keep theirs.

Written against `origin/main` at `2a8c2712c`. References are to sections and symbols, not
lines. Issues and PRs are cited by number only.

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

These are not open, and the questions in §6 are asked inside them.

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

**D4 — Advisory by default; only a platform-owned script may block.** Every finding starts
advisory. A finding can ever block anything only if a script confirmed it, and only a script whose
result the platform owns (§2.2). A model's finding never blocks, whatever its item's severity and
whatever confidence the model claims.

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
archive, and stored beside the version record it was pushed with. When C arrives it builds from
that same archive, so moving from A to C changes who builds, not what is uploaded or stored. The
diff the reader half reads is computed platform-side, between this archive and the archive of the
last reviewed version of the same vertical. Retention of the archive is Q3b.

D3, D4 and D5 together are the builder studio's verification rule applied to review: *rank checks
by who authored the oracle* (`docs/architecture/builder/studio.md` §9). A gate whose expected
output is derived from committed artifacts, run by tooling the platform controls, is high-trust; a
model's reading is a reading.

### 2.1 What D4 does to the checklist's vocabulary

The checklist today has one axis, **severity**: an item is `blocking` ("the change is unsafe to
merge as written") or `advisory` ("worth a comment, never a stop"). D4 adds a second axis that the
checklist does not yet carry, **confirmation**: was this finding decided by a platform-owned
script, or by a reader. The two are independent:

| | confirmed by a platform-owned script | judged by a reader (person or model), or by a customer-owned script |
|---|---|---|
| **severity `blocking`** | may block, once Q4 allows it | shown prominently; never blocks |
| **severity `advisory`** | never blocks | shown; never blocks |

So "S5 · Personal data is classified and erasable: blocking" stays a blocking-severity item, and a
model's S5 finding is still advisory, because no script confirmed it. The checklist's report shape
already has the hook for this: a finding the reader could not settle is `[S5 unconfirmed]`. This
RFC asks (Q5d) that the per-item `judgement` mark the gates work introduces be what the hosted
runner reads, rather than a list kept inside the runner.

### 2.2 What makes a script's result platform-owned

A gate result counts as *script-confirmed* in the sense of D4 only when all of the following
hold. They follow from D4 and are not offered as options; the questions below assume them.

1. **The tool is the platform's.** The gate runs from the runner's own pinned, read-only tool
   image, never from the customer's tree, `node_modules` or package scripts. In a project made by
   `npm create substrat`, the checklist's boundaries gate is `npm run lint:boundaries` — the
   customer's own script, which runs whatever their `package.json` says. The hosted runner calls
   its own pinned boundary-lint against the tree instead, and never the project's script. The
   same holds for every gate the checklist names by a project script.
2. **Reading before executing.** Gates that read source as text run before anything installs or
   executes customer code, in a filesystem that step never shares.
3. **No customer lifecycle scripts.** Where a gate needs dependencies, they are installed from a
   clean state with package lifecycle scripts disabled. A gate that cannot run without them is not
   a platform-owned gate.
4. **The verdict is observed, not reported.** Only an exit status observed by the runner's own
   process counts. Text a gate prints is never parsed into a pass or a fail.
5. **The gate environment holds no write credential**, including no credential to the review
   record (§4).

A script that does not meet all five is **customer-owned**: the customer's own tests (the
`scenario` gate runs them) and any project script are in this class. Their results are reported,
with their output treated as untrusted text (Q6a), and they never confirm a finding. If these
conditions cannot be met for a gate, that gate cannot block, whatever Q4 says.

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
| Turning a feature on for a tenant | Entitlements, stored in the directory and projected into each scope; granted per tenant by staff from the console. A tenant's own credential may grant itself only the keys `tenantGrantableEntitlement` allows (narrowed by #977). The builder studio's own entitlement is the precedent. | No review entitlement or per-vertical switch (Q2). |
| Staff reads | Every staff read of the directory is recorded in the access log (K-24). | — |

## 4. The shape

Whatever the answers below, the runner has three parts, and no two share a process or a
credential.

- **The gate half** takes the source archive (D5), runs the gates in a disposable container under
  the conditions of §2.2, and returns each gate's name, status and exit code.
- **The reader half** takes the diff, the checklist, the procedure and the gate half's structured
  results, asks one model about the `judgement` items only, and returns candidate findings.
- **The assembler** is the only part that writes. It checks each candidate finding against the
  diff (Q6a), combines the findings with the gate results, and writes the **review record**, keyed
  by the vertical version, through the one endpoint that accepts it (Q6c). Every surface in Q3
  reads that record. It also builds the model host (D-59) in platform code, so the usage line is
  observed rather than self-reported — the shape #1073 wants for every model call, which a review
  gets without waiting for it.

None of the three writes to the customer's code, the version record or any scope.

```
                       ┌──▶ gate half (container, no credential) ── status, exit code ─┐
  source archive (D5) ─┤                                                              ├─▶ assembler ─▶ review record ─▶ surfaces (Q3)
                       └──▶ diff ─▶ reader half (model host, no exec) ── candidates ──┘                    └─▶ promote check (Q4)
                                         ▲ checklist + procedure @ pinned digest (Q5)
```

## 5. Principles the options are judged against

1. **A clean report must mean something.** A review that did not run, ran out of budget, could
   not see the change, was not sent part of it, or could not run a gate is never shown as clean.
   `skipped`, `incomplete`, `partial` and `blocked` are states of their own (the checklist already
   says a gate not run is *not run*, never passed).
2. **The customer's text is data, never instructions.** The change, its comments, its file names,
   its commit messages and anything a customer-owned script prints are written by the party being
   reviewed.
3. **Each part can do one thing.** The gate half executes and holds nothing; the reader half reads
   and executes nothing; the assembler writes one record (Q6c).
4. **What blocks is reproducible.** A blocking finding is one anyone can re-run the platform's
   script for and get the same answer (§2.2).
5. **Store the code once.** The source archive is stored with the version (D5) and nowhere else;
   the record keeps findings, not code.

## 6. Questions for the human

Each question gives lettered options, a recommended default, what it depends on, and what it costs
if the recommendation turns out wrong. Where the recommendation combines options, the question says
the options may be combined.

### Q1 — Metering, the model, and a per-review budget

**Q1a — Which model.**

- **A. One model, chosen by the platform, pinned per checklist version.** The review record
  names it (Q5b). Changing it is a release of the runner, measured against the false-positive
  corpus (Q7) before it ships.
- **B. The tenant picks from the catalogue**, as #1054's picker intends for the assistant.
- **C. Bring your own key**, through a tenant connection (#1073's BYOK).
- *Depends on:* C on #1073.
- *Recommendation:* **A.** A finding's quality depends on the model, and Q7's numbers are
  meaningless if every tenant's reviews come from a different one. B and C can follow once the
  numbers exist per model. *If wrong:* tenants with a residency or vendor constraint (D-54: the
  model provider is a disclosed subprocessor the tenant may constrain) cannot use the reader half
  until B or C lands. The jurisdiction rule in Q3c limits the damage: a vertical serving an `eu`
  scope gets no model review rather than a `global` one.

**Q1b — Who pays.**

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

- **A. Refuse before the call.** Estimate the input from the change's size before anything is
  sent; a change over the cap is recorded as `skipped: too large`, with the size, and the gates
  still run.
- **B. Cap during the call.** A hard output and step bound; a review that hits it is recorded
  `incomplete`, with the items it did not reach listed.
- **C. Allow and bill.**
- *Recommendation:* **A and B together, and never C.** Plus a per-tenant spend limit enforced
  in the model host's `guard` before each call (#1054 §5), so a tenant's reviews cannot spend past
  what its admin set. The `guard` seam exists and nothing passes one today; the runner would be its
  first platform-side user. The gate half has its own caps (Q6c). An `incomplete` or `skipped`
  review is never shown as clean (§5.1). The numbers are set from phase-1 data, not here. *If
  wrong:* a cap set too low turns most real changes into `skipped`, which reads as a broken
  product; too high, and a vendored dependency committed by mistake costs real money. Phase 1
  exists to find the number.

### Q2 — The enable surface

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
  whoever may change the vertical's settings.
- *Recommendation:* **C**, with the switch on the vertical's Settings and every change of state
  recorded with who made it and when. Turning it off stops new reviews and deletes nothing. The
  review entitlement key is **not tenant-grantable** through phases 1–2: it stays out of
  `tenantGrantableEntitlement`, so only staff can grant it, in the same way `tools/reserved-keys.mts`
  keeps `assistant:run` from any person's role. It becomes plan-shaped at phase 3. *If wrong:* A
  alone cannot trial the runner on one vertical of a tenant with many, and charges for all of them;
  B alone leaves staff no lever during the advisory phases. C costs one extra switch.

### Q3 — Where findings are shown when there is no pull request

**Q3a — The surfaces.** The options may be combined; the question is which, and in which order.

- **A. The record and a CLI read.** One review record per (vertical version, checklist digest,
  model), stored platform-side, and a CLI verb (`substrat review <version>`, or a field on
  `substrat versions`) that prints it as text, so an agent driving the CLI reads findings without
  a browser. Every other surface reads the same record; none holds its own copy.
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
- Not offered: **the console as a findings surface.** Staff see the review's state (ran, skipped,
  cost), not its findings; Q10 covers staff access.
- *Depends on:* A and C need D5's upload in the CLI; without source there is nothing to review.
- *Recommendation:* **A, then B, then C; D last and optional per vertical.** *If wrong:* building B
  before A leaves an agent that pushes (the case the runner exists for) with nothing to read;
  building D first makes GitHub the real surface, which D2 set out to avoid.

**Q3b — What is stored, and for how long.**

Two things are stored, and this question sets both: the **source archive** (D5), which must exist
from the push until the asynchronous review has run and which later reviews diff against, and the
**review record**.

- **A. Archive with the version; record of findings and digests only.** The archive is kept while
  the version is in the vertical's channel history and for 180 days after it stops serving (the
  window the platform already uses for issues and findings), so the next review can diff against
  it and C can later build from it. The record holds each finding (item, severity, confirmation,
  `file:line`, a bounded quote, fails-when, fix), each gate's name, status and exit code, the
  checklist digest, the model spec, the runner version, the archive digest and the base archive's
  digest, the token counts and container time. **Not** the prompt and **not** the model's
  transcript; the diff is recomputed from the two archives when needed.
- **B. A, with the archive deleted once its review has run.** The next review then has no base to
  diff against, and C has nothing to build from, so this conflicts with D5; listed for completeness.
- **C. A, plus the full transcript**, for debugging the runner.
- *Depends on:* C would feed Q7's corpus; A feeds it only through opt-in cases.
- *Recommendation:* **A.** The record lives in a store of its own (not the #1748 findings store,
  whose findings are recurring and fingerprinted rather than tied to one version), on the same
  retention as the archive. The record's usage line follows the model ledger's own 400 days, like
  every other model call. Quotes are bounded (one line, a fixed character cap) and pass the same
  redaction step the assistant RFC proposes for tenant text before they are stored. Both the
  archive and the record are deleted when the vertical is deleted and when the tenant is reaped
  (#36); a quote that survived redaction is erased with its record under subject erasure, since a
  record has no other copy. *If wrong:* without C we cannot re-read the model's reasoning behind a
  disputed finding, only the finding and the code; choosing C later is a policy change tenants must
  be told about.

**Q3c — Personal data, jurisdiction, and what is sent to the model.**

The change is the customer's source code, which can contain personal data: seed files, test
fixtures, a persona list, a sample import. Sending it to a model provider is a disclosure to a
subprocessor (D-54).

*Path exclusions.*

- **A. Send the diff as it is**, to a provider listed as a subprocessor.
- **B. A, minus platform-defined exclusions**: lockfiles, binary files, generated files and files
  over a size cap, recorded as `not sent` in the record.
- **C. B, plus customer-declared exclusions** (seed and fixture globs), set by a tenant admin on
  the vertical's Settings, not in the pushed tree.
- *Recommendation:* **C**, with two rules. An exclusion narrows only what the **reader half** is
  sent; the gate half always gets the full tree. And any file excluded by a customer-declared glob
  makes the review `partial`, shown in the headline with the globs in force, never clean (§5.1).
  Redaction of secrets and contact data applies to what is **stored** (the quotes), not to what is
  sent: redacting source before a reviewer reads it changes the code under review, and S7 (secrets)
  is exactly an item that needs to see a hard-coded token to report it. *If wrong:* C's exclusions
  mean a personal-data field added in an excluded seed file is not seen by the reader half; S5 on
  the model file still is, which is where the classification lives.

*Jurisdiction (K-32).*

- **A. The reader half follows jurisdiction; nothing else does.**
- **B. Every part that processes the code follows it**: the reader half's provider route, the gate
  container, and the store holding the archive and the record.
- *Recommendation:* **B.** Jurisdiction is recorded per scope, and a review has no scope, so the
  review takes the strictest jurisdiction among the scopes the vertical serves — preview scopes
  included — **evaluated when the review starts**, and the record stores the jurisdiction it ran
  under. If that is `eu` or `us`, each part runs only where a placement in that region exists; a
  reader half without one is `skipped: no provider in jurisdiction`, never a silent `global`
  route, and a gate half or store without one means the review does not run at all. A scope added
  later does not move a completed record; the next review is evaluated afresh. *If wrong:* A keeps
  the provider in region while the code itself is stored and executed elsewhere, which is the
  inconsistency D-53 was written against.

*Provider retention.* The reader half calls the model over the HTTP gateway row, which sends
`cf-aig-collect-log-payload: false`, so the gateway logs counts and cost and not the prompt. It
never uses the `env.AI` binding path, which names no gateway (D-59) and so carries no such setting.
A provider's own operational retention (abuse monitoring) applies unless zero retention is
contracted for this traffic; the provider is listed as a subprocessor with its retention stated.

### Q4 — May a finding gate `substrat push`

The rule from D4 holds in every option: **only a script-confirmed finding of blocking severity
may block**, where *script-confirmed* means §2.2's five conditions held. A customer-owned script's
result is reported and never blocks.

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
- *Depends on:* D5's controlled build (C), which is phase 4's precondition, and Q7's per-item
  thresholds.
- *Recommendation:* **A until phase 4; then B, opt-in per vertical, default off.** Never C: the
  review is slower than an upload, a preview is how a builder sees the problem, and refusing the
  upload removes the one place the finding is easiest to act on.
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

### Q5 — Keeping the local and hosted runners on one checklist

**Q5a — How the hosted runner gets the file.**

- **A. Bundled from this repository at the runner's build**: the runner's source imports
  `plugin/substrat/review/checklist.md` as text, so the deployed runner holds exactly the file at
  the commit it was built from. No copy exists to drift.
- **B. Fetched at run time from the published plugin**, at a pinned plugin version.
- **C. Read from the customer's repository** (their copy of the plugin, or a checklist they ship).
- *Recommendation:* **A.** It satisfies D1 with no copy and no generated file, so it needs none of
  the three marks of a generated artifact. B adds a network dependency and a second source of
  truth (whatever the registry serves). **C is rejected**: the rules a change is reviewed against
  must not come from the change. *If wrong:* a checklist edit reaches the hosted runner only when
  the runner is redeployed; that is a release step, and Q5b makes it visible.

**Q5b — Versioning, and what a record pins.**

- **A. A content digest**: the sha256 of the checklist file's bytes, computed at build, plus the
  plugin version it shipped in.
- **B. A hand-kept version field** in the checklist.
- *Recommendation:* **A.** A hand-kept version is a field that exists only to go wrong (the same
  reason `docs/` has no `updated:` field). Both runners print the digest in the report's headline,
  so a local report and a hosted record can be compared at a glance, and a builder whose local
  plugin is older sees that the two reviews used different rules. A review record pins: the
  checklist and procedure digest and the plugin version, the runner's own version, the model spec,
  the gate image's version, and the archive digests (D5). *If wrong:* without a digest, a finding
  cannot be tied to the rule text that produced it, and Q7's per-item numbers mix rule versions.

**Q5c — The procedure.** The local skill's procedure (find the change, run gates read-only, read,
disprove, report) is written in `SKILL.md`, not in the checklist.

- **A. Move it beside the checklist** (`plugin/substrat/review/procedure.md`, or a section of the
  checklist), have the skill point at it as it points at the checklist, and include it in the
  digest. The hosted runner's prompt is then the checklist, the procedure, the diff and the gate
  results, and nothing else.
- **B. Leave it in the skill**, and have the hosted runner keep its own procedure.
- *Recommendation:* **A.** *If wrong:* under B the two runners drift on procedure while sharing the
  rules: the hosted one stops disproving its candidates, say, and its false-positive rate rises
  for a reason Q7 cannot see.

**Q5d — Which items the model reads.**

- **A. The checklist says.** Each item, or each part of an item, carries the `judgement` mark the
  gates work (D3) introduces, and the runner asks the model about exactly those.
- **B. The runner keeps its own list** of items to send to the model.
- *Recommendation:* **A.** B is a second copy of a fact about the rules, which D1 forbids; it
  would also let the two runners disagree about which items a model reads. The local runner, which
  is itself a model, reads every item but reports a script item through its gate (as the checklist
  already instructs), so the mark changes nothing locally. *If wrong:* an item that loses its gate
  and keeps no mark is read by neither half, silently; Q8's phase-0 exit condition (every item is
  a gate or marked `judgement`) is what refuses that.

### Q6 — Trust and abuse

The change, and anything a customer-owned script prints, is text the reviewed party controls.
Each sub-question offers **A, the structural set listed**, or **B, a narrower set** (named in the
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
- *Recommendation:* **A.** *The stated limit:* a reader can be talked out of a `judgement` finding.
  That is why those findings are advisory by construction, and why no gate depends on the reader.

**Q6b — What must hold so that findings are not suppressed or forged.**

| Concern | What must hold |
|---|---|
| The rules | The runner never reads the customer's copy of the checklist (Q5a). |
| Instructions in the change or in gate output | Q6a. |
| A gate result influenced from inside the tree | §2.2: the platform's own tool image, text gates before any install, no customer lifecycle scripts, verdicts by observed exit status, no write credential in the gate environment. **This is the precondition for any blocking**: without it a result is customer-owned and cannot block under Q4. |
| A boundaries gate run through a project script | The runner's pinned boundary-lint, never `npm run lint:boundaries` (§2.2.1). |
| The uploaded tree differing from the deployed bundle | D5's controlled build before phase 4; until then no finding blocks. |
| A bad change split across many pushes | The diff base is the last **reviewed** version's archive, not the last pushed one; a full-tree review can be requested. |
| A change too large to review | `skipped: too large`, never clean (Q1c). |
| Customer-declared exclusions covering source | The review is `partial`, with the globs shown (Q3c); the gate half still gets the full tree. |
| The runner turned off | The switch is recorded (Q2); for a listed vertical, admission sees that the version has no review. |

- **A. Every row above.**
- **B. Every row except the controlled build**, which is D5's and already scheduled.
- *Recommendation:* **A**, which with D5 decided means the rows are requirements of their phases
  (Q8).

**Q6c — Credentials, isolation and blast radius.**

- **A. All of:**
  - **What may be read:** the gate half reads the one archive it was issued; the reader half reads
    the diff, the checklist and procedure, and the gate half's results. Nothing in any scope: no
    tenant data, no vertical secret or env value, no other vertical's code, no other tenant's
    anything.
  - **What each part holds:** the gate half holds nothing but a single-use read handle for its
    archive, issued per review and expiring with it. The reader half never sees a model
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
  customer's code run, and everything else is `not run`.
- *Recommendation:* **A, with B as the state before the container exists.** Phase 1 reviews only
  our own verticals, so its gate half may run without a container, still holding no credential;
  **the container is a precondition of the first customer's review** (phase 2). *If wrong:* a gate
  half that holds any credential gives code in the reviewed tree that credential's reach; there is
  no "mostly isolated" version of this.

### Q7 — False-positive tracking before anything becomes required

The options may be combined.

- **A. Owner feedback.** Each finding can be marked *fixed*, *not a problem* (with a reason) or
  *won't fix*, from the dashboard or the CLI. Feedback never clears a promote refusal (Q4 B).
- **B. An automatic signal.** A finding whose quoted line changed in the next reviewed version
  counts as probably fixed; one that survives unchanged through several versions with no feedback
  counts as probably ignored.
- **C. A seeded corpus.** Our own demo verticals' history plus a set of known-bad changes, one or
  more per checklist item, run on every runner, model or checklist change, measuring both false
  positives and misses.
- *Recommendation:* **all three.** C first, because it needs no customer and is the only one that
  measures misses. Numbers are kept per (item, checklist digest, model), aggregated, with no code
  content. The bar before Q4 B may be offered for any item is a published threshold per item (for
  example, a minimum number of reviews over at least four weeks, with the share marked *not a
  problem* under a stated ceiling); the human sets the numbers at phase 3. For script-confirmed
  items the expectation is no false positives at all: one is a gate bug, fixed in the gate. *If
  wrong:* without A, the runner cannot learn which items annoy; without C it cannot tell a quiet
  runner from a blind one.

### Q8 — Rollout

- **A. The phases below.**
- **B. The phases below without phase 1**, starting with invited tenants.
- *Depends on:* D5 (the controlled build before phase 4), Q6c (the container before phase 2), Q7
  (thresholds before phase 4).
- *Recommendation:* **A.**

| Phase | Who | What runs | Exit when |
|---|---|---|---|
| 0 | — | This RFC answered; the `judgement` marks and the gates work (D3) landed; the checklist digest printed by the local skill; the CLI uploads the source archive (D5 A). | Every checklist item is either a gate or marked `judgement`. |
| 1 | Staff, on our own demo verticals and the seeded corpus | Gates under §2.2, without a container, holding no credential; reader half on one model; records stored; CLI read only. Zero-rated. | Q1c's caps set from real numbers; Q7 C has a baseline per item; the container gate half works. |
| 2 | Invited tenants, by staff-granted entitlement | Advisory only. Record, CLI read, dashboard, push headline. Container gate half from the first customer review. Metered, zero-rated. | Owner feedback (Q7 A) over at least four weeks; cost per review known, model and container. |
| 3 | Any tenant that enables it | Advisory only. Metered and billed (Q1b). Plan-shaped entitlement. | Per-item thresholds published; **the controlled build (D5 C) builds the bundle from the uploaded archive**. |
| 4 | Opt-in per vertical | Q4 B: script-confirmed blocking findings refuse promote, with an owner override, on versions the platform built. | — |

*If wrong:* B puts unmeasured caps in front of a customer; skipping phase 2's advisory window makes
Q4's threshold a guess.

### Q9 — Decided

Where the reviewed change comes from is decided: §2, D5.

### Q10 — Who may read a review record

- **A. Anyone who may see the vertical's versions** in the dashboard.
- **B. Tenant owners and admins only.**
- **C. A, plus the CLI credential that pushed the version.**
- *Depends on:* C's CLI read needs D5's upload in the CLI.
- *Recommendation:* **C.** The findings quote the tenant's own code, so anyone who may already see
  that vertical's deploys may see them; the pushing credential must read them for the agent case
  (Q3a). Staff are not given a findings view (Q3a); a staff read of a record, for a support case or
  otherwise, is recorded in the access log like every other staff read (K-24). *If wrong:* B hides
  findings from the builder who has to fix them.

## 7. Recommended answers, in one table

| Q | Topic | Recommended | Depends on |
|---|---|---|---|
| Q1a | Which model | A: one platform-chosen model, pinned per checklist version | C on #1073 |
| Q1b | Who pays | A: metered to the tenant through the model ledger; zero-rated in phases 1–2 | attribution form on #1073 |
| Q1c | Per-review budget | A + B: refuse before the call, hard cap during it; per-tenant spend limit in the guard; never shown as clean | — |
| Q2 | Enable surface | C: entitlement per tenant (not tenant-grantable in phases 1–2), switch per vertical, held by tenant owner and admin | Q1b |
| Q3a | Surfaces | A, then B, then C; D last and optional; not the console | A and C on D5 |
| Q3b | Stored and retention | A: archive with the version, record of findings and digests; channel history then 180 days; deleted on vertical delete and tenant reap | — |
| Q3c | Personal data and jurisdiction | Exclusions C (customer globs make it `partial`); jurisdiction B, evaluated at review start; HTTP gateway row only | — |
| Q4 | Gating push | A until phase 4; then B (gate promote, recorded owner override), opt-in; never C | D5 C, Q7 |
| Q5a | Checklist source | A: bundled from this repository at build | — |
| Q5b | Versioning | A: content digest plus plugin version, printed by both runners | — |
| Q5c | Procedure | A: move it beside the checklist and into the digest | — |
| Q5d | Which items the model reads | A: the checklist's own `judgement` mark | — |
| Q6a | Prompt injection | A, including gate output as untrusted data | — |
| Q6b | Suppression and forgery | A: every row; §2.2 is the precondition for any blocking | D5 C |
| Q6c | Credentials and isolation | A; B only before the container exists | — |
| Q7 | False positives | A + B + C; corpus first; thresholds set at phase 3 | — |
| Q8 | Rollout | A: phases 0–4, the controlled build before phase 4 | D5, Q6c, Q7 |
| Q9 | Source of the change | Decided: D5 | — |
| Q10 | Who reads a record | C: version viewers plus the pushing credential; staff reads in the access log | D5 |

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
  one can be placed by jurisdiction, is in the repository. Q3c B and Q6c depend on both.
- **Which gates run in a scaffolded project without the monorepo** under §2.2. The checklist says a
  scaffolded project has three (`lint:boundaries`, `typecheck`, `test`); the builder-workspace
  runner names eight. Which of the eight can run from the platform's own image against an external
  vertical's tree is not established.
- **Provider routes per jurisdiction** for the model Q1a would pick: not recorded here, and the
  assistant RFC lists the same gap.
- **Which jurisdiction a review takes** (Q3c). The strictest of the vertical's scopes is this
  RFC's proposal; nothing in the repository decides jurisdiction for code rather than data.
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
