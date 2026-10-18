---
status: proposed
layer: plan
description: The platform-hosted half of the Substrat review checklist (#2365). Records what #2368 and the maintainer already decided (one runner-neutral checklist, no model key in GitHub CI, mechanical gates first, the model trusted only for judgement items, advisory until a script confirms) and lays out ten numbered questions with options, a recommended default and the cost of being wrong — metering and model, the enable surface, where findings live and for how long, gating a push, checklist versioning, trust and abuse, false-positive tracking, rollout, where the reviewed change comes from, and who may see a record.
---

# RFC: the hosted review runner

**Status: proposed. Nothing here is agreed beyond §2**, which records decisions already taken.
It answers the part of [#2365](https://github.com/substrat-run/substrat/issues/2365) that #2368
left open: the hosted runner. It recommends; a human decides. The decisions it asks for are §6,
numbered so they can be answered as `Q1: A, Q2: B, …`; §7 collects the recommended answers in
one table.

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

**D4 — Advisory by default; only a script may block.** Every finding starts advisory. A finding
can ever block anything only if a script confirmed it. A model's finding never blocks, whatever
its item's severity and whatever confidence the model claims.

D3 and D4 together are the builder studio's verification rule applied to review: *rank checks by
who authored the oracle* (`docs/architecture/builder/studio.md` §9). A gate whose expected output
is derived from committed artifacts is high-trust; a model's reading is a reading.

### 2.1 What D4 does to the checklist's vocabulary

The checklist today has one axis, **severity**: an item is `blocking` ("the change is unsafe to
merge as written") or `advisory` ("worth a comment, never a stop"). D4 adds a second axis that the
checklist does not yet carry, **confirmation**: was this finding decided by a script, or by a
reader. The two are independent:

| | confirmed by a script | judged by a reader (person or model) |
|---|---|---|
| **severity `blocking`** | may block, once Q4 allows it | shown prominently; never blocks |
| **severity `advisory`** | never blocks | shown; never blocks |

So "S5 · Personal data is classified and erasable: blocking" stays a blocking-severity item, and a
model's S5 finding is still advisory, because no script confirmed it. The checklist's report shape
already has the hook for this: a finding the reader could not settle is `[S5 unconfirmed]`. This
RFC asks (Q5) that the per-item `judgement` mark the gates work introduces be what the hosted
runner reads, rather than a list kept inside the runner.

## 3. What exists

| Need | What `main` has | Gap |
|---|---|---|
| The rules | `plugin/substrat/review/checklist.md`: eight items S1–S8, each with a severity, a *Gate* line and a *Reader* line; a fixed report shape (`Substrat review: <n> blocking, <m> advisory`, `file:line`, quote, fails-when, fix; `Checked clean`, `Not applicable`, `Gates run`). | No version or digest of its own; it rides the plugin's version (`plugin.json` `version`, 0.3.0). No machine-readable `judgement` mark yet (in flight, D3). |
| A procedure | The `review` skill: diff against the merge-base, run the gates read-only, read each item, **try to disprove each candidate**, report. Never edits, never passes a checkpoint. | The procedure lives in the skill, not beside the checklist, so a second runner would have to copy it (Q5). |
| A gate runner over a sandbox | `packages/builder-workspace`: `gates.ts` runs the tier-1 gates (`install`, `model`, `typecheck`, `boundary-lint`, `permissions`, `api`, `scenario`, `migration-replay`) and reports `passed`/`failed`/`blocked`/`skipped`, with exit 2 from Substrat's own tools read as *blocked* ("we learned nothing"), never as *failed*. `container.ts` runs the same `Workspace` seam over a Cloudflare Sandbox container. | Built for the studio's own loop. Nothing runs it against a pushed vertical's change. |
| Model calls and their ledger | `@substrat-run/model-providers` (provider table, catalogue, generated rate card); `createModelHost` in `@substrat-run/vertical-host` with an optional `guard` consulted before the call (the budget seam) and a `record` that yields one `ModelUsageLine` after it. A vertical raises the line as a `model-usage` platform intent and the drain writes it to the platform's ledger, kept 400 days (`MODEL_USAGE_RETENTION_DAYS`); the margin (`MODEL_MARGIN_PERCENT`) is applied at read time. D-59. | The host runs **in the vertical**, so the line is self-reported and no budget is enforced on that path; #1073 designs the platform-side, connector-shaped host and is not built. The review runner is platform code, so it can construct the host itself and write an observed line. `ModelAttribution` is fixed at five keys and **requires a `scope`**; a review is about a vertical version, not a scope (Q1). |
| Metering a tenant's usage in its own scope | `engine-metering`: an append-only ledger of quantities inside a scope, deduplicated per meter, with closed periods. It knows no prices and enforces no limit. ticket0 records its assistant's tokens there beside the platform intent. | A review runs outside every scope, so the engine is not where a review's cost lands; the model ledger is. |
| What the platform holds of a push | A **built bundle**, never source: the deploy endpoint runs in a Worker and cannot bundle (`docs/architecture/self-serve-deploy.md` §2). `versionOrigin` records `source` (`git`/`cli`), `gitRepo`, `gitCommit`, `gitRef`, and the CLI's push-gate receipt `gate` (`passed`/`skipped`/`none`, #955), all self-reported: *"the platform never lints the uploaded bundle (it receives built output, not source)"*. | **The platform has no copy of the change to review.** This is the precondition the issue did not name (Q9). |
| A link to the customer's git | The dashboard's GitHub App: installation tokens, repository and branch listing, `pull_request` webhooks, and `upsertPrComment`, which keeps one marked comment per pull request up to date. Repository CI setup (`setupRepoCi`) needs the installation to hold contents, workflow and secret write. Nothing server-side clones or reads a repository's contents; *"the platform cannot build a PR's code — the repo's own CI does."* | GitHub only, and an installation that can write. Nothing equivalent for another git host. |
| Where a version is shown | The dashboard's Deployments tab, per vertical and per version, where `OriginTag` already renders the push-gate receipt and flags anything but `passed`; the promote dialog, backed by `PromotionReview` (the permission and migration diff); the console for staff; `substrat push` / `substrat versions` output. | No review status anywhere. |
| Tenant-facing findings | The findings store (#1748): per tenant, recurring operational findings with a status (`open`, `acked`, `resolved`, `suppressed`) and suppress rules, kept 180 days after the last occurrence (`FINDING_RETENTION_DAYS`). | A different thing with the same word: those are recurring and keyed by fingerprint, a review finding is about one version's code (Q3b). |
| Turning a feature on for a tenant | Entitlements, stored in the directory and projected into each scope; granted per tenant by staff from the console. Tenant self-grant was removed (#977). The builder studio's own entitlement is the precedent. | No review entitlement or per-vertical switch (Q2). |

## 4. The shape, in one paragraph

Whatever the answers below, the runner has two halves that never share a process. The **gate
half** takes the change, runs the mechanical gates in a disposable sandbox that holds no platform
credential, and records each gate's result (the builder-workspace runner, in a container). The
**reader half** takes the change as text, the checklist, and the gate results, asks one model
about the `judgement` items only, and turns the answer into findings that must each quote a line
the change actually contains. Neither half writes to the customer's code, the version record or
any scope. Both write to one **review record**, keyed by the vertical version, which is what every
surface in Q3 shows. The model call goes through a model host (D-59) that the runner constructs
in platform code, so its usage line is observed rather than self-reported, the shape #1073 wants
for every model call and that a review gets without waiting for it.

```
  change (Q9) ──▶ gate half (sandbox, no secrets) ──▶ gate results ─┐
        │                                                           ├─▶ review record ──▶ surfaces (Q3)
        └──────▶ reader half (model host, no exec) ──▶ findings ────┘        │
                         ▲ checklist @ pinned digest (Q5)                    └─▶ promote check (Q4)
```

## 5. Principles the options are judged against

1. **A clean report must mean something.** A review that did not run, ran out of budget, could
   not see the change or could not run a gate is never shown as clean. `skipped`, `incomplete`
   and `blocked` are states of their own (the checklist already says a gate not run is *not run*,
   never passed).
2. **The customer's text is data, never instructions.** The change, its comments, its file names
   and its commit messages are written by the party being reviewed.
3. **The runner can read one change and write one record.** It holds no write access to anything
   else (Q6).
4. **What blocks is reproducible.** A blocking finding is one anyone can re-run the script for
   and get the same answer.
5. **Store the least.** The record keeps findings, not the code.

## 6. Questions for the human

Each question gives the options, a recommended default and what it costs if the recommendation
turns out wrong. Q9 is listed last to keep the numbering of the issue's own list, but it is the
precondition for Q3, Q4 and Q6: read it first if you read only one.

### Q1 — Metering, the model, and a per-review budget

**Q1a — Which model.**

- **A. One model, chosen by the platform, pinned per checklist version.** The review record
  names it (Q5). Changing it is a release of the runner, measured against the false-positive
  corpus (Q7) before it ships.
- **B. The tenant picks from the catalogue**, as #1054's picker intends for the assistant.
- **C. Bring your own key**, through a tenant connection (#1073's BYOK).
- *Recommendation:* **A.** A finding's quality depends on the model, and Q7's numbers are
  meaningless if every tenant's reviews come from a different one. B and C can follow once the
  numbers exist per model; C also depends on #1073, which is not built. *If wrong:* tenants with a
  residency or vendor constraint (D-54: the model provider is a disclosed subprocessor the tenant
  may constrain) cannot use the runner until B or C lands. The jurisdiction rule in Q3c limits the
  damage: an `eu` tenant gets no review rather than a `global` one.

**Q1b — Who pays.**

- **A. Metered to the tenant** at list price times the platform margin, through the same ledger
  as every other platform-run model call (`ModelUsageLine`, D-59), as a line attributed to the
  review.
- **B. Included** in a plan, the platform absorbing the cost, metered for our own information
  only.
- **C. A flat price per review**, independent of tokens.
- *Recommendation:* **A, always metered; zero-rated while the runner is staff-only or invite-only
  (phases 1–2 of Q8).** The ledger line is written from the first review either way, because Q7
  and the budget both need the numbers. *If wrong:* A makes a large change expensive in a way the
  tenant did not predict, which the per-review budget below caps; C would hide that but needs a
  price we cannot set without phase-2 data.
- *Open detail either way:* `ModelAttribution` has five fixed keys and requires a `scope`. A review
  has a tenant, a vertical and a version, and no scope. Either the attribution gains a review form
  (a change to a frozen five-key shape whose fixed width exists for provider metadata limits), or
  the review is attributed to a platform-owned sentinel scope per tenant. This needs deciding with
  #1073's platform-side model host, not here.

**Q1c — A per-review budget, and what happens on overspend.**

- **A. Refuse before the call.** Estimate the input from the change's size before anything is
  sent; a change over the cap is recorded as `skipped: too large`, with the size, and the gates
  still run.
- **B. Cap during the call.** A hard output and step bound; a review that hits it is recorded
  `incomplete`, with the items it did not reach listed.
- **C. Allow and bill.**
- *Recommendation:* **A and B together, and never C.** Plus a per-tenant spend limit enforced
  in the model host's `guard` before each call (#1054 §5), so a tenant's reviews cannot spend past
  what its admin set. The `guard` seam exists and nothing passes one today; the runner would be its
  first platform-side user. An `incomplete` or `skipped` review is never shown as clean (§5.1), and the
  gate half runs whatever the reader half could afford. The numbers (input cap, output cap) are set
  from phase-1 data, not here. *If wrong:* a cap set too low turns most real changes into
  `skipped`, which reads as a broken product; too high, and a vendored dependency committed by
  mistake costs real money. Phase 1 exists to find the number.

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
- *Recommendation:* **C**, with the switch on the vertical's Settings and the change of state
  written to the tenant's admin log. Turning it off stops new reviews and deletes nothing. The
  entitlement stays staff-granted through phase 2 and becomes plan-shaped at phase 3. *If wrong:*
  A alone cannot trial the runner on one vertical of a tenant with many, and charges for all of
  them; B alone leaves staff no lever during the advisory phases. C costs one extra switch.

### Q3 — Where findings are shown when there is no pull request

**Q3a — The surfaces.**

- **The record.** One review record per (vertical version, checklist digest, model), stored
  platform-side. Every surface below reads it; none holds its own copy.
- **The dashboard**, on the version in the Deployments tab: the headline (`n blocking, m
  advisory`, or `skipped`/`incomplete`), the gates run, and the findings in the checklist's own
  report shape.
- **`substrat push`**: prints the headline and a link once the review exists. The review is
  asynchronous (the model call takes longer than an upload should wait), so push does not wait by
  default; a flag waits for it and exits non-zero only when Q4 says so.
- **A CLI read** (`substrat review <version>`, or a field on `substrat versions`): the same record
  as text, so an agent driving the CLI reads findings without a browser.
- **A preview**: a pull-request preview (`substrat preview create`, D-43) is a pushed version like
  any other and gets its record the same way. A deploy workflow that runs on GitHub may copy the
  headline into its own job summary; that is the customer's CI printing our CLI's output, not our
  runner holding a GitHub credential (D2).
- **A pull-request comment, where the repository is linked through the dashboard's GitHub App.**
  `upsertPrComment` already keeps one marked comment per pull request. The comment would carry the
  headline and a link, never the findings' quotes, and it is written by the dashboard from the
  record, not by the runner (Q6c). This is a convenience for one git host, so nothing may depend
  on it.
- **Not the console.** Staff see the review's state (ran, skipped, cost), not its findings,
  unless the tenant opens a support case; the findings quote the customer's code (Q10).
- *Recommendation:* the record, the CLI read, the dashboard version view and the push headline,
  built in that order; the pull-request comment last and optional per vertical. *If wrong:*
  building the dashboard first, before the CLI read, leaves an agent that pushes (the case the
  runner exists for) with nothing to read; building the pull-request comment first makes GitHub
  the real surface, which D2 set out to avoid.

**Q3b — What the record stores, and for how long.**

- **A. Findings and digests only.** Each finding (item, severity, confirmation, `file:line`, a
  bounded quote, fails-when, fix), each gate's name and status, the checklist digest, the model
  spec, the runner version, the digests of the change reviewed, the token counts. **Not** the
  change itself, **not** the prompt, **not** the model's transcript.
- **B. A, plus the change**, kept for a fixed window for audit and false-positive review.
- **C. A, plus the full transcript**, for debugging the runner.
- *Recommendation:* **A**, kept in a record of its own (not the #1748 findings store, whose
  findings are recurring and fingerprinted rather than tied to one version), retained while the
  version is in the vertical's channel history and for 180 days after it stops serving, the
  window the platform already uses for issues and findings; deleted with the vertical. The
  record's usage line follows the model ledger's own 400 days, like every other model call.
  Quotes are bounded (one line, a fixed character cap) and pass the same redaction step the
  assistant RFC proposes for tenant text (secrets and contact data removed before storage). The
  diff and the prompt exist only for the duration of the run. *If wrong:* without B we cannot
  re-read the exact change behind a disputed finding; Q7's corpus relies on our own demos plus
  tenants who opt in to share a case, which is slower. Choosing B or C later is a change of policy
  the tenant must be told about; choosing B now and retracting it is a deletion nobody can
  verify.

**Q3c — Personal data and the model provider.**

The change is the customer's source code, which can contain personal data: seed files, test
fixtures, a persona list, a sample import. Sending it to a model provider is a disclosure to a
subprocessor (D-54).

- **A. Send the change as it is**, to a provider listed as a subprocessor with no retention and no
  training on the traffic.
- **B. A, plus exclusions**: paths the runner never sends (seed and fixture data by declared glob,
  lockfiles, binary and generated files, files over a size cap), recorded as `not sent` in the
  record.
- **C. B, plus content redaction** of what looks like a secret or contact data before sending.
- *Recommendation:* **B**, with C's redaction applied to what is **stored** (the quotes) rather
  than to what is sent: redacting source before a reviewer reads it changes the code under review,
  and S7 (secrets) is exactly an item that needs to see a hard-coded token to report it. The
  provider route follows the tenant's jurisdiction (K-32): an `eu` or `us` tenant is reviewed only
  where a route in that region exists, and otherwise gets gate results with the reader half
  `skipped: no provider in jurisdiction`, never a silent `global` route. *If wrong:* B's exclusions
  mean a personal-data field added in a seed file is not seen by the reader half; S5 on the model
  file still is, which is where the classification lives.

### Q4 — May a finding gate `substrat push`

The rule from D4 holds in every option: **only a script-confirmed finding of blocking severity
may block**, and only from a gate the platform owns. A customer's own tests (the `scenario` gate
runs them) are a script, but their oracle is the customer's; a failing customer test is reported,
and never used by the platform to block.

- **A. Never.** The review is advisory forever; blocking stays with the CLI's own gates (#955)
  and with admission for listed verticals.
- **B. Gate promotion, not upload.** A version with an open script-confirmed blocking finding
  uploads, previews and can be reviewed; `substrat push --promote prod` and the dashboard's
  promote refuse it, naming the finding. The promote dialog's `PromotionReview` is where the
  dashboard already shows what a promote is about to change, so the refusal and the override
  belong there. A private vertical's owner may override with a recorded
  reason, written to channel history beside the promote; a listed vertical's override is staff
  admission's, not the owner's.
- **C. Gate the upload.** Push waits for the review and refuses on a blocking finding.
- *Recommendation:* **A until Q7's numbers exist; then B, opt-in per vertical, default off.**
  Never C: the review is slower than an upload, a preview is how a builder sees the problem, and
  refusing the upload removes the one place the finding is easiest to act on.
- *Why an owner override is enough for a private vertical:* D-36 already says a private vertical's
  only audience is its own tenant; the gate protects the builder from their own agent, not other
  tenants from the builder. For a listed vertical the audience is wider, and a human at admission
  is the right holder of the override.
- *If wrong:* letting anything but a script block means a model's mistaken finding stops a
  production deploy, and a prompt-injected change can *create* a blocking finding to stop someone
  else's deploy, which is a denial of service by text. Gating on scripts only removes both. If B
  is chosen before Q9 is answered with B or C, the gate is only as strong as the source the
  customer chose to upload: enough for a builder's own safety net, not a control anyone else can
  rely on.

### Q5 — Keeping the local and hosted runners on one checklist

**Q5a — How the hosted runner gets the file.**

- **A. Bundled from this repository at the runner's build**: the runner's source imports
  `plugin/substrat/review/checklist.md` as text, so the deployed runner holds exactly the file at
  the commit it was built from. No copy exists to drift.
- **B. Fetched at run time from the published plugin**, at a pinned plugin version.
- **C. Read from the customer's repository** (their copy of the plugin, or a checklist they ship).
- *Recommendation:* **A.** It satisfies D1 with no copy and no generated file, so it needs none of
  the three marks of a generated artifact. B adds a network dependency and a second source of
  truth (whatever the registry serves). **C is rejected**: the party under review would write the
  rules it is reviewed against, and could delete an item or add an instruction to the reader.
  *If wrong:* a checklist edit reaches the hosted runner only when the runner is redeployed;
  that is a release step, and Q5b makes it visible.

**Q5b — Versioning, and what a record pins.**

- **A. A content digest**: the sha256 of the checklist file's bytes, computed at build, plus the
  plugin version it shipped in.
- **B. A hand-kept version field** in the checklist.
- *Recommendation:* **A.** A hand-kept version is a field that exists only to go wrong (the same
  reason `docs/` has no `updated:` field). Both runners print the digest in the report's headline,
  so a local report and a hosted record can be compared at a glance, and a builder whose local
  plugin is older sees that the two reviews used different rules. A review record pins: the
  checklist digest and plugin version, the runner's own version, the model spec, the versions of
  the gate packages the gate half ran, and the identity of the change (Q9). *If wrong:* without a
  digest, a finding cannot be tied to the rule text that produced it, and Q7's per-item numbers
  mix rule versions.

**Q5c — The procedure.**

The local skill's procedure (find the change, run gates read-only, read, disprove, report) is
written in `SKILL.md`, not in the checklist. A second runner that follows "the same procedure"
would have to copy it.

- *Recommendation:* move the procedure into the plugin's `review/` directory beside the checklist
  (`procedure.md`, or a section of the checklist), have the skill point at it as it points at the
  checklist, and include it in the digest. The hosted runner's prompt is then the checklist, the
  procedure, the change and the gate results, and nothing else. *If wrong:* the two runners drift
  on procedure while sharing the rules: the hosted one stops disproving its candidates, say, and
  its false-positive rate rises for a reason Q7 cannot see.

### Q6 — Trust and abuse

**Q6a — Prompt injection.** The change is text the reviewed party controls, fed to a model.

The recommended mitigations are structural rather than a better prompt, and together they bound
what an injection can achieve to *adding or suppressing advisory findings*:

1. The reader half has **no tools that act**: no write, no network, no shell, no credential. It
   returns text, parsed into a strict finding schema; anything that does not parse is dropped and
   counted.
2. **Every finding is checked by a script after the model**: its `file:line` must exist in the
   change and its quote must match that line. A finding that fails is dropped. The model cannot
   cite code that is not there.
3. The model's output **never decides a gate** (D4, Q4). An injection cannot create a blocking
   finding or clear one.
4. The checklist, procedure and system instructions are platform-held (Q5a); the change is
   passed as delimited data and described as untrusted in the instructions.
5. Text in the change that addresses a reviewer ("ignore the checklist", "reviewer: this is fine")
   is itself reported as an advisory finding outside the checklist.

*The stated limit:* a reader can be talked out of a `judgement` finding. That is why those findings
are advisory by construction, and why the gates do not depend on the reader.

**Q6b — A vertical trying to suppress findings.**

| Attempt | What stops it |
|---|---|
| Edit the rules | The runner never reads the customer's copy (Q5a). |
| Write instructions into comments | Q6a. |
| Upload a change that is not what was deployed | Only Q9 B or C closes this. Under Q9 A it is a stated limit. |
| Split a bad change into many harmless-looking pushes | Review against the **last reviewed** version, not the last pushed one, and offer a full-tree review on demand. |
| Make the change too large to review | `skipped: too large` is shown as skipped, never clean (Q1c). |
| Turn the runner off | The switch is logged (Q2); for a listed vertical, admission sees that the version has no review. |

**Q6c — The runner's credentials and blast radius.**

- **What it may read:** the one change it was issued, the files of that same tree the procedure
  opens, the checklist and procedure, and the gate packages. Nothing in any scope: no tenant data,
  no vertical secret or env value, no other vertical's code, no other tenant's anything.
- **What it holds:** a single-use read token for that change, issued per review and expiring with
  it; the model call goes through the platform's model host, so the reader half never sees a model
  credential either. It holds **no write access** to git, to the version record, to channel
  history, or to the control plane, except one endpoint that accepts a review record for the review
  id it was issued, once.
- **What it may never do:** promote, admit, bind, roll back, comment on a pull request, push to a
  repository, or acknowledge a checkpoint. Q4's promote check reads the record; the runner does not
  act on it.
- **Isolation:** the gate half executes customer code (`install` runs package scripts; `scenario`
  runs the customer's tests). It runs in a disposable container per review with no platform
  credential in its environment and network limited to the package registry, and it is discarded
  after the run. The reader half runs no customer code. The two halves exchange only the gate
  results, as data.
- *Recommendation:* all of the above, and for phase 1 a gate half that runs only the gates that
  execute no customer code (boundary-lint over source text, the migration replay through the
  kernel's own `replayMigrations`) until the container half is built. *If wrong:* a gate half that
  holds any platform credential turns a malicious `postinstall` into platform access; there is no
  "mostly isolated" version of this.

### Q7 — False-positive tracking before anything becomes required

- **A. Owner feedback.** Each finding can be marked *fixed*, *not a problem* (with a reason) or
  *won't fix*, from the dashboard or the CLI.
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

| Phase | Who | What runs | Exit when |
|---|---|---|---|
| 0 | — | This RFC answered; the `judgement` marks and the gates work (D3) landed; the checklist digest printed by the local skill. | Every checklist item is either a gate or marked `judgement`. |
| 1 | Staff, on our own demo verticals and the seeded corpus | Gate half without customer code execution; reader half on one model; records stored; CLI read only. Zero-rated. | Q1c's caps set from real numbers; Q7 C has a baseline per item. |
| 2 | Invited tenants, by entitlement | Advisory only. Record, CLI read, dashboard, push headline. Container gate half. Metered, zero-rated. | Owner feedback (Q7 A) over at least four weeks; cost per review known. |
| 3 | Any tenant that enables it | Advisory only. Metered and billed (Q1b). Plan-shaped entitlement. | Per-item thresholds published. |
| 4 | Opt-in per vertical | Q4 B: script-confirmed blocking findings refuse promote, with an owner override. | — |

*If wrong:* skipping phase 1 puts unmeasured caps in front of a paying tenant; skipping phase 2's
advisory window makes Q4's threshold a guess.

### Q9 — Where the reviewed change comes from

The platform holds a built bundle, not source (§3). A reviewer needs source.

- **A. The CLI uploads the change with the push**: the source tree, or the diff against the last
  reviewed version, sent beside the bundle with its digest. Works for any git host, or none.
  Self-reported, like the rest of `versionOrigin`: nothing proves the bundle was built from it.
- **B. The platform reads a repository it was granted**: a connected git host through a
  read-only credential held platform-side, or the repository the platform already hosts for a
  studio-generated vertical (D-53), at the commit `versionOrigin.gitCommit` names. Stronger than A
  about *which* commit, still not proof the bundle came from it. For GitHub this is the
  dashboard's App, whose installation can write (it commits the deploy workflow and sets a
  secret); the runner must be handed a read-only, single-repository token minted for the one
  review, never the installation's own (Q6c).
- **C. A controlled build**: the platform builds the bundle from source in its own sandbox
  (`docs/architecture/self-serve-deploy.md` §3, model A). The reviewed source is then the deployed
  source by construction.
- *Recommendation:* **A for phases 1–3**, because it is the only option that is independent of the
  git host (D2) and needs no new connector; **B or C before phase 4** for any vertical whose
  promote a finding may refuse, and **C before a listed vertical's admission relies on a
  record**. *If wrong:* under A, a builder can show the reviewer a different change from the one
  they deploy. For an advisory safety net on one's own private vertical that harms only the person
  doing it; for anything another party relies on, it makes the record decorative. B costs a git
  connector per host and a credential we hold; C costs the build service self-serve-deploy §3
  already calls a real supply-chain surface.

### Q10 — Who may read a review record

- **A. Anyone who may see the vertical's versions** in the dashboard.
- **B. Tenant owners and admins only.**
- **C. A, plus the CLI credential that pushed the version.**
- *Recommendation:* **C.** The findings quote the tenant's own code, so anyone who may already see
  that vertical's deploys may see them; the pushing credential must read them for the agent case
  (Q3a). Staff see state, not findings (Q3a). *If wrong:* B hides findings from the builder who
  has to fix them.

## 7. Recommended answers, in one table

| Q | Topic | Recommended |
|---|---|---|
| Q1a | Which model | A: one platform-chosen model, pinned per checklist version |
| Q1b | Who pays | A: metered to the tenant through the model ledger; zero-rated in phases 1–2 |
| Q1c | Per-review budget | A + B: refuse before the call, hard cap during it; per-tenant spend limit in the guard; never shown as clean |
| Q2 | Enable surface | C: entitlement per tenant, switch per vertical, held by tenant owner and admin |
| Q3a | Surfaces | Record first, then CLI read, dashboard version view, push headline; an optional pull-request comment last; not the console |
| Q3b | Stored and retention | A: findings and digests only, in a record of its own; while the version is in channel history, then 180 days |
| Q3c | Personal data to the model | B: path exclusions; redact what is stored, not what is sent; provider follows jurisdiction |
| Q4 | Gating push | A now; B (gate promote, owner override) at phase 4, opt-in; never C |
| Q5a | Checklist source | A: bundled from this repository at build |
| Q5b | Versioning | A: content digest plus plugin version, printed by both runners |
| Q5c | Procedure | Move it beside the checklist and into the digest |
| Q6 | Trust and abuse | Structural: no acting tools, script-checked quotes, no credentials, container per review |
| Q7 | False positives | A + B + C; corpus first; thresholds set at phase 3 |
| Q8 | Rollout | Phases 0–4 as tabled |
| Q9 | Source of the change | A for phases 1–3; B or C before phase 4; C before admission relies on it |
| Q10 | Who reads a record | C: version viewers plus the pushing credential |

## 8. Not proposed

- **No GitHub Actions job and no model key in this repository or in a customer's CI** (D2).
- **No model finding ever blocks** (D4). Nothing here proposes a confidence threshold above
  which a model's finding becomes blocking.
- **No review of the built bundle.** It is minified output; review reads source or nothing.
- **No runner-specific rules.** A rule the hosted runner needs goes into the checklist, where the
  local runner reads it too.
- **No runner credential on the customer's git host.** The one write to a git host this RFC
  allows is the dashboard's existing pull-request comment, made from the record (Q3a); the runner
  itself writes nowhere but its record.
- **No change** under the excluded areas: the control plane's connection and email routes, the
  connect-round code, the social relay, the WfP upload path.

## 9. Unverified

- **Container cost and start time per review.** The builder studio runs `ContainerWorkspace`;
  no figure for a short-lived per-review container is recorded in the repository.
- **Which gates run in a scaffolded project without the monorepo.** The checklist says a
  scaffolded project has three (`lint:boundaries`, `typecheck`, `test`); the builder-workspace
  runner names eight. Which of the eight a pushed external vertical can run is not established.
- **Provider routes per jurisdiction** for the model Q1a would pick: not recorded here, and the
  assistant RFC lists the same gap.
- **Whether `ModelAttribution` can take a review without a scope** (Q1b) without breaking the
  five-key limit's reason: unexamined.

## Alternatives rejected

- **A GitHub Actions job with a model key** (#2365's original ask). Ties the runner to one git
  host, puts a model key where every workflow edit can reach it, and meters nothing per customer.
- **The runner reading the customer's checklist** (Q5a C). The reviewed party would write the
  rules.
- **Model findings blocking above a confidence score.** A model's confidence is another output of
  the same model; it is not a second oracle, and it is as open to injection as the finding.
- **Storing the diff by default** (Q3b B as the default). It makes the platform a second holder of
  every customer's code history for a benefit (re-reading a disputed finding) that opt-in sharing
  gives for the cases that need it.
