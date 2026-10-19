---
status: proposed
layer: plan
description: "A store driver's release runs once a person approves its uploaded bytes in the control plane, instead of once this repo pins its sha256. The maintainer decided the RFC's sixteen questions on 2026-10-19; the D-63 amendment itself is still to be written. Keeps D-63's person, canary, rollback, schema and isolation rules; moves the per-release pin into a revocable, audited approval keyed by (driver, sha256); keeps the driver id and its isolation basis in source."
---

# RFC: store driver releases are uploaded and approved, not pinned in source

**Status: proposed.** The maintainer decided all sixteen questions on 2026-10-19 (§9). The
amendment to D-63 that this plan needs is not written yet. This RFC changes no code, no
`STORE_DRIVERS` entry and no D-NNN file. Where it needs a surface that does not exist, the
surface is marked *(proposed)*.

Written against `origin/main` at `3f7cd82f8`, and checked again at `71751ace1`. References are to
files and symbols, not lines. [#2394](https://github.com/substrat-run/substrat/pull/2394), the
graph driver's first pin, is cited as context only.

---

## Summary

**The model in ten lines.**

1. A release is what `substrat store-driver upload` sends. The platform computes its sha256 when
   it arrives and stores it under (driver, sha256), as it does today.
2. An upload alone never makes a release runnable.
3. A person with a staff sign-in approves one (driver, sha256), in a separate write. The service
   token cannot approve.
4. The approval carries the release's class name, operation catalog and `schema`, the source
   references the approver read, and an isolation review. These facts are fixed at the release's
   first approval.
5. A move to a release (a rollout, a rollback, a push or serve that builds a script, a rebuild)
   needs a live approval. Leaving a release does not.
6. An approval stands until a person revokes it. Revoking is refused while any script still runs
   the release, unless the person passes an emergency flag and a reason.
7. The revoke check walks every script's own settings under the driver's exclusive hold, paged
   as a rollout is. No second record of which release a script runs is kept.
8. The driver id, and its isolation basis, stay compiled into this repo. A driver written outside
   this repo is registered only with a decision record that lifts D-63's isolation requirement for
   it.
9. The canary over every reserved operation, the rollback to the previous good release, the rule
   against a lower `schema`, and the re-hash before every upload all stay.
10. A failed read of approvals refuses (503). Nothing is cached.

**Decided answers** (§9 has each with its reasoning).

| | question | decided |
|---|---|---|
| Q1 | Does a recorded approval stand in for D-63's "reviewed change in this repo"? | Yes, when it carries the isolation review of §6 |
| Q2 | What stays in source? | The driver id. The class name, catalog and `schema` move to the approval |
| Q3 | Two people? | Record uploader and approver. No two-person rule yet |
| Q4 | Revoking a running release? | Refused unless an emergency flag and a reason are given |
| Q5 | Is the graph driver third-party? | Yes. D-63's isolation sentence still gates it. No claim is made that it is met |
| Q6 | Source references? | A structured list of (repository, commit) |
| Q7 | `*.dist-info` exclusion? | Deferred |
| Q8 | #2394? | Lands the graph driver id only and drops its pin |
| Q9 | Does an approval expire? | No. It stands until revoked. The module rule's refusal is the only automatic stop |
| Q10 | A canary at approval? | No. The canary runs at rollout only |
| Q11 | Who reads a stored release? | Staff only |
| Q12 | Correcting a wrong fact? | Not possible. A wrong fact needs new bytes, so a new sha256 |
| Q13 | Approvals read on the push path? | Fail closed (503). No caching |
| Q14 | A condition reviewed "not met"? | Recorded. It does not refuse |
| Q15 | A table of which release each script runs? | Dropped. The revoke guard walks every script's settings under the hold |
| Q16 | A dependency built from another repository? | Third-party. It must be listed in the approval's source references |

**Essential, and hardening that can wait.**

- *Essential*, because without it the model is weaker than pins:
  - approvals written only by a person, per (driver, sha256);
  - a live approval required for every move to a release, on every path;
  - leaving a release judged from its approval facts, revoked or not;
  - revoke with the walking guard and the emergency flag;
  - the isolation basis in source, checked at registration and wherever an approval is read;
  - `releases` and `className` removed from the registration in the same change that switches
    the readers;
  - a failed read refuses (503);
  - the first rollout waits for the deploy that first admits an approved release.
- *Hardening that can wait*:
  - the release manifest on the stored row (§4.1);
  - the staff read of a stored release (§4.1). Until it exists, the approver reviews the bundle
    they hold and compares its `storeDriverReleaseDigest` with the stored sha256;
  - `restore()`'s own detail when `from` is revoked (§4.2). Without it, the outcome is already
    `diverged`, but the detail gives the wrong reason;
  - `status` naming the scripts that still run a revoked release;
  - a two-person rule (Q3);
  - the `*.dist-info` exclusion (Q7);
  - a controlled build from source (§4.1).

**Rollout order in five steps** (§8 has the detail).

1. **Decide.** A decision record amends D-63 with the sentences of §5.1.
2. **Vocabulary and directory.** The new admin actions and the response fields ship first.
   `store_driver_approvals` and the revoke walk ledger join the directory. Nothing reads them yet.
3. **Routes, CLI and isolation basis.** Approve, revoke and status ship, and the registration
   gains its isolation basis field.
4. **The switch.** Every reader of `registration.releases` and `className` moves to approvals in
   one change, and those fields leave the registration.
5. **Register, approve, roll out.** The driver id and its basis are registered. For the graph
   driver, that waits for the decision record that lifts D-63's isolation sentence for it. A person
   approves the first release. The first rollout waits until a person attests that the
   registering deploy has finished.

---

## 1. What D-63 does today

[D-63](../decisions/D-063-a-store-kind-is-platform-code-registered-and-pinned-like-a-connector.md)
makes a store driver platform code that is registered in this repo, and runs a release of it
only once this repo pins the release. In code:

- **The registry is compiled in.** `STORE_DRIVERS` in `packages/contracts/src/deploy.ts` is a
  list of `storeDriverRegistration`: the driver id (today the schema admits only `graph`), the
  class name, the operation catalog, the reserved operations, and `releases`, at least one
  `storeDriverRelease` of `{ sha256, sourceCommit, schema }`. The list is empty on `main`, and
  `packages/contracts/test/scope-stores.test.ts` asserts that it is.
- **An upload stores bytes and names them.** `substrat store-driver upload`
  (`packages/cli/src/store-driver.ts`) packs `driver_<name>/` and `python_modules/` from `--dir`
  (`packStoreDriverDir`). It skips `__pycache__`, `.pyc` and the two `INSTALLER_MARKERS`.
  `sourceCommitOf` refuses a driver file that is untracked or changed at `HEAD`, and holds
  `python_modules/` to neither check. The body goes to `PUT /store-drivers/:driver/releases`
  (`packages/control-plane-api/src/api.ts`). There `storeDriverRelease()`
  (`packages/control-plane-api/src/store-releases.ts`) decodes the body
  (`decodeStoreDriverRelease`, which applies the module rule), computes
  `storeDriverReleaseDigest` itself, stores the bytes under `<driver>/<sha256>`, and records
  the release in the directory's insert-only `store_driver_releases` table
  (`packages/kernel/src/store-driver-releases.ts`). The response says whether the sha256 is
  pinned.
- **A rollout runs only a pinned release.** `POST /store-drivers/:driver/rollouts` and
  `/rollback` go through `pinOf`, which refuses a release that is not stored (404), not pinned
  (422), or stored under another commit than its pin (422). `assertSchemaKept` refuses a lower
  `schema`. `runStoreDriverRollout` takes the driver's exclusive hold for one request, canaries the
  release on a platform-owned object (`canaryStoreRelease`, every reserved operation), and moves
  each vertical. A fleet larger than one request is paged: the request ends `paused`, releases the
  hold, and posting the same rollout again continues from the attempt's walk ledger
  (`store_driver_rollout_walks`, #2312). Each request begins a new `store_driver_rollouts` row.
- **Every upload of a script checks the pin again.** The ensurer behind every upload (push,
  serve, rollout, rollback, the fleet rebuild of `store-rebuild.ts`), `scriptEnsurer` in
  `packages/control-plane-api/src/store-script.ts`, copies the bytes it is about to send,
  hashes them, and refuses a sha256 its registration does not pin. It also refuses to move a
  script to a lower `schema`. This RFC calls that check *the sha256 gate*. It has been in the
  ensurer since #2299. A push or serve never moves a script: it creates a missing script at the
  driver's current good release, and rebuilds an existing one at the release it runs, which it
  reads from the script's own settings (`STORE_RELEASE_VAR`, through `recorded()`).
- **Several gates read "is a driver registered" from the same list.** `assertScopeStoresRegistered`
  (contracts, run by the CLI's push check and by the control plane) and `scopeStoreUploadPlan`
  (`packages/control-plane-api/src/deploy.ts`) refuse a store whose driver is not in it.
  `mayHoldScopeStores` (contracts), read by `runningVersionStoresOf` and `scopeStoreReachOf` in
  `packages/control-plane-api/src/platform-scope-stores.ts`, answers "no scope can hold a store"
  while the list is empty. Once it is not, backup, wipe and erasure refuse (503) a scope whose
  stores cannot be named.
- **Writes are made by a person.** The four write routes run `byAPerson` in `api.ts`. It takes
  JSON only, refuses another origin, and requires `humanStaffActor` to name the same actor from
  a human staff sign-in, so the automation service token is refused. Each write is audited
  under an action of `adminAction` (`packages/contracts/src/control-plane.ts`):
  `uploadStoreDriverRelease`, `rollOutStoreDriver`, `rollBackStoreDriver`, `rebuildStoreDriver`.

## 2. What went wrong on #2394

#2394 adds the first registration, `graph`, with one pinned release. Four problems were found
while reviewing it. None of them is a bug in the current code. Each comes from where the pin
lives.

1. **The pin can never run.** The pinned bundle holds three files that the module rule refuses.
   The bundle was packed against an earlier draft of #2390's rule. As merged (#2391),
   `PYTHON_VENDORED_RESERVED` in `deploy.ts` refuses `asgi` and the `_cloudflare` and `_pyodide`
   prefixes. The upload route and the ensurer both decode with that rule. So no upload of these
   bytes can succeed, and D-63 says a pin is never removed.
2. **The sha256 cannot be reproduced.** The bundle is install output. The installer that writes
   `python_modules/` also writes bytes that depend on the machine and the time it ran. So the
   commit and its lock do not rebuild the same sha256. The bundle also carries a dependency built
   from a second repository at its own commit, and `sourceCommit` names only one commit. D-63
   already says "the platform enforces the sha256, not the commit". The pin assumed more.
3. **A wrong pin is permanent.** D-63's "Pins are never removed" keeps a superseded or defective
   release publishable. Its withdrawal is a named follow-up that does not exist yet.
4. **A repack is three steps by three hands.** Changing one byte needs a person with a staff
   sign-in to upload again, a reviewed change to this repo for the new pin, and a control-plane
   deploy.

The maintainer added two points on 2026-10-19. First, this repo should not depend on other
projects: a driver's class name, its catalog, its digests and commits in another repository are
facts about that project. Second, the platform should compute the digest when a release is
pushed, the way it records a vertical's bundle when the vertical is pushed.

## 3. What must not change

**A store driver is not a vertical.** A vertical runs isolated. It has its own script per
version, no binding to another scope, and an egress hop (D-46). A store driver runs in one
script per (driver, vertical), across every tenant of that vertical, next to their data (D-63,
Why). So the vertical's model, where the push records a digest and the bundle runs, does not
transfer as it stands. **An upload alone must never make a driver release runnable.** This RFC
moves where approval is recorded. It does not remove approval.

These stay exactly as they are:

- A person publishes. `byAPerson` stays the rule for every write, and so does refusing the
  service token.
- The canary over every reserved operation, before any vertical moves.
- A rollback goes to the immediately previous good release, which each rollout records.
- No move to a lower `schema`, whether a rollout, a rollback or the return after a failure.
- The sha256 gate: every upload of a script hashes the bytes it sends and checks them again.
- D-63's isolation requirement (§6).

D-63 rejected the unpinned proposal of #2298 for three reasons. This RFC answers each of them:

1. *"It names who may publish but not that a person must."* Here the approval is a write of its
   own, made only by a person (§4.2).
2. *"The sha256 … records what arrived and is no provenance."* That is still true here, and the
   RFC does not claim otherwise (§7). Provenance is the approver's statement of what they
   reviewed, recorded on the approval and not verified by the platform.
3. *"And without a pin, no reviewed change in this repo stands behind a release, while that
   review is the only control until the isolation above exists."* The proposal keeps the second
   half. Until isolation exists, the review of a release stays the only control, and it is still
   a person's review of the exact bytes. What it overturns, on purpose, is the first half: where
   that review is recorded. A recorded review in the control plane replaces a reviewed change in
   this repo. The gate on isolation itself stays a reviewed change in this repo (§6). The
   maintainer accepted this (Q1).

## 4. The proposal

### 4.1 A release is an upload, named by the platform

A driver release is what `substrat store-driver upload` sends today. The route, body and CLI stay
the same. The platform computes `storeDriverReleaseDigest` when the body arrives, as
`storeDriverRelease()` already does, and stores the bytes and the row keyed by (driver, sha256),
as it already does. Nothing about a release is added to this repo.

Two additions, both *(proposed)* and both hardening that can follow the switch:

- **The stored row describes the release.** Beside `sha256`, `source_commit`, `uploaded_by` and
  `uploaded_at`, the row keeps the entry, the module count, the byte count, and a list of module
  names with each module's own sha256. A reviewer can then see what the digest covers without
  unpacking the bytes. This is derived from the bytes, so it is not a second source of truth.
- **A staff read of a stored release** (Q11: staff only). It returns the manifest above and the
  bundle as stored, so a reviewer can read the exact bytes the digest names. Today nothing serves
  them back.

**Rejected alternatives.**

- *A tool that writes the pin into `STORE_DRIVERS` from an upload.* It still needs a merged
  change and a deploy for every release, and it still puts another project's facts into this
  repo. It automates problem 4 and solves none of the others.
- *An allowlist file that the registration names.* D-63 allows this. It has the same costs as a
  pin in the registration.
- *The platform builds the release from source.* This is the only option that would make a
  source reference provenance. It needs the platform to fetch another project's source and run
  its installer in a controlled build. That is the long-term answer to §7, the same move as the
  hosted review runner's "later the input of a controlled build"
  ([hosted-review-runner.md](./hosted-review-runner.md), D5). It is too large to wait for, and it
  does not remove the need for an approval.
- *Releases signed by the driver's authors.* This moves trust to a key the platform does not
  hold, and it records nothing about review by the platform's staff.

### 4.2 Approval is data in the control plane, granted by a person

A release becomes runnable through an **approval**, a separate write after the upload, recorded
in the control plane's directory.

- **Keyed per digest and per driver.** An approval names one (driver id, sha256). Approving bytes
  for one driver approves nothing for another, even when the bytes are the same. Approving one
  release approves no other release of the driver.
- **Made by a person.** The approve and revoke routes *(proposed)* run `byAPerson`, exactly as
  the upload does: a human staff sign-in, JSON only, same origin, and the service token refused.
  The uploader and the approver are both recorded. They may be the same person (Q3).
- **What the row records** *(proposed table `store_driver_approvals`)*: the driver, the sha256,
  an approval id, who approved and when, a required reason, the source references the approver
  read (§7), the isolation review (§6), and the release's facts: its `schema`, its class name and
  its operation catalog (§4.4). It also records who revoked it, when, why, and whether the
  emergency flag was passed. Rows are append-only, with the revoke columns written once: nothing
  else on a row ever changes, a row is never deleted, and approving the same release again after
  a revoke writes a new row.
- **At most one live approval per (driver, sha256).** The table holds a unique index over
  (driver, sha256) for rows not revoked *(proposed)*, so a second approval of a release that is
  already approved is refused (409).
- **A release's facts are fixed at its first approval.** `schema`, the class name and the catalog
  are facts about one set of bytes. A later approval of the same (driver, sha256), after a revoke,
  must carry the same three facts, or it is refused (409). A fact that turns out wrong needs new
  bytes, and so a new sha256 (Q12). That costs one upload and one approval. In return, every
  approval row of a release agrees on its facts, so the release a script is leaving can be judged
  from any of them, and no record of which releases have run is needed.
- **Each lookup is judged by its role, not by its function.** A lookup of the release a script
  is **leaving** reads that release's approval facts **whether or not it is revoked**. These are
  `assertSchemaKept`'s `from` in `api.ts`, the ensurer's `running` lookup, and in `restore()`
  (`store-releases.ts`) the `leaving` side, `schemaOf(deps.registration, deps.sha256)`. A lookup
  of a release a script is **moving to** needs a live approval. These are the rollout and
  rollback target (`pinOf`), the ensurer's target (`pin`), the canary ensurer's target, and in
  `restore()` the `returning` side, `schemaOf(deps.registration, from)`. `schemaOf` serves both
  roles today, so it becomes two reads. Without that split, a revoked running release could never
  be left: today each lookup refuses (409) a release it cannot find.
- **Its own witness.** An audited verb writes its admin-log row after the mutation, in a separate
  write, and that gap is accepted (#1292, [control-plane.md](../architecture/control-plane.md)
  §4.4). So who approved, when and why are columns of the approval row, not only fields of the
  log. The log row is the second record. New actions *(proposed)*: `approveStoreDriverRelease`
  and `revokeStoreDriverRelease`.
- **CLI** *(proposed)*: `substrat store-driver approve --driver <id> --sha256 <hex> --reason <text>`
  and `substrat store-driver revoke …`. `store-driver status` lists each release with its upload,
  its approval and any revocation.

**What running requires: uploaded, approved and rolled out.** Each of the three is checked where
it is checked today, and every check fails closed:

| check | today | proposed |
|---|---|---|
| uploaded | `pinOf` 404; ensurer 409 when `loadRelease` finds no bytes | unchanged |
| approved | `pinOf` 422 when the sha256 is not in `registration.releases`; ensurer 422 the same way | the target of a move needs a live approval for (driver, sha256), under a registration whose isolation basis admits it (§6). A read that fails refuses (503). It never counts as approved, and nothing is cached (Q13) |
| commit matches | `pinOf` 422 when the stored commit is not the pinned one. That is a control, because the pin comes from a reviewed change | no longer a control. `storeDriverRelease()` already refuses (409) a second commit for a stored sha256, and the release row is never rewritten. The approval copies the upload's `sourceCommit` as a consistency check only. §7's source references are a separate list and are not compared |
| schema | `assertSchemaKept`, and the ensurer's schema check, read `registration.releases[].schema` | the target's `schema` comes from its live approval. The release being left comes from its approval facts, revoked or not |
| class name | the ensurer and the canary ensurer read `registration.className` | read from the target's approval. The loader returns the approval's facts with the bytes *(proposed)*, so `withPythonStoreEntry` builds from the class the release was approved with |
| module rule | `decodeStoreDriverRelease` at upload and when the ensurer loads the bytes | unchanged. A release the current rule refuses does not run, approved or not, and `status` says why. This is the only thing that stops an approval without a person (Q9) |
| rolled out | a rollout or rollback moves a script; a push or serve never moves one | unchanged |

**Revocation.** Revoking stops every later upload of that release: a rollout, a rollback to it,
a push that would create a script at it, a serve, and the fleet rebuild. It does not stop a
script that already runs the release, because an upload is the only lever the platform has over a
running script. A revoked release is never a rollback target. The rollback answers 422, as an
unpinned target does today (control-plane.md §4.4).

**What a revoke of a running release costs.** The ensurer checks the target before its no-op
shortcut (`current.release === sha256 && current.build === build` in `scriptEnsurer`), and
`ensureScopeStoresOf` in `api.ts` rethrows, failing the push or serve. A push or serve rebuilds a
script at the release it runs, so that release is the ensurer's target. While a vertical's script
runs a revoked release, **every push and every serve of that vertical is refused**, until a
rollout moves its script. A fleet rebuild after a key change cannot rebuild those scripts either,
so they keep the older key lists until they are rolled forward, and the rebuild reports them as
pending.

**The revoke guard walks the scripts** (Q4, Q15). A revoke without the emergency flag is refused
(409) while the release is current, or while any script of the driver runs it. The guard reads
each script's own `STORE_RELEASE_VAR`, through the ensurer's `recorded()`. No second record of
which release a script runs is kept, so there is nothing to reconcile and nothing to backfill.

- **Under the exclusive hold, one page per request.** Each revoke request takes the driver's
  exclusive hold (`holdStoreDriver`, mode `exclusive`), the hold a rollout takes, so no push,
  serve, rebuild or rollout uploads a script while the page is read. A page reads at most
  `ROLLOUT_WALKS_PER_REQUEST` verticals, from `storeDriverDeclarations`, in slug order. A
  driver with more verticals is walked over several requests, as a rollout is. The request answers
  `paused`, releases the hold, and posting the same revoke again continues.
- **A revoke walk ledger** *(proposed table `store_driver_revoke_walks`, one row per (driver,
  sha256))* holds the cursor, the person, and the newest `store_driver_rollouts` seq when the walk
  began. It is a cursor, like `store_driver_rebuilds`. It records nothing about which release a
  script runs.
- **Why the pages add up.** Between two requests the hold is released. A script's release
  changes only in two ways. A rollout or rollback request moves it, and every such request begins
  a new `store_driver_rollouts` row, `restore()`'s returns included. Or a push creates a missing
  script, which `scriptEnsurer` uploads at the driver's current good release. So each page, under
  the hold, first refuses if the release is current, and starts the walk again from the first
  vertical if the newest rollout seq has moved since the walk began. A script that a page has
  already read as not running the release therefore still does not run it on the last page.
- **Fails closed.** A script whose settings cannot be read, a script that records no release
  (`scriptEnsurer` already refuses one with 409), or a vertical `storeDriverDeclarations` lists
  as `unreadable` refuses the revoke. The refusal names the script, the release it runs and the
  rollout to do first.
- **The canary script first.** A rollout whose canary failed leaves the canary script on that
  release (`createStoreCanaryEnsurer` moved it before the canary ran), while no vertical's script
  moved. The first page reads the canary script too. When it runs the release and a current good
  release exists, the revoke moves it back to current first. The canary ensurer may move to any
  `schema`, because every canary object is fresh and wiped. Without that step, the fleet rebuild,
  which walks the canary script first (`store-rebuild.ts`), would meet it on a revoked release and
  end `failing` until the next rollout. With no current release (a driver's first rollout failed
  its canary), the canary script stays where it is, and the rebuild reports it until a rollout.
- **The write.** On the last page, still under the hold, the revoke is written and the ledger row
  is removed.
- **The emergency flag.** A person may pass an explicit emergency flag and a reason
  *(proposed)*. The revoke is then written at once, without the walk, accepting that pushes and
  serves of every vertical whose script runs the release are refused until a rollout. That is the
  fail-closed answer when a release must not be uploaded again even once.

**After an emergency revoke of the current release, the only way out is forward.** When a
roll-forward from the revoked release fails part way, `restore()` would return the verticals it
reached to `from`, the revoked release. That is a move to a release without a live approval, so
it is refused. Today a missing `returning` schema falls into the "would lower the stored schema
(X to undefined)" branch: the outcome, `diverged` with nothing returned, is already right, and
only the reason is wrong. `restore()` gets a branch of its own *(proposed, hardening)*, checked
before the schema comparison, whose detail says `from` is revoked and names the verticals now on
the new release. The rollback is refused (422) because its target is revoked. The recovery is
another rollout to an approved release, the same one once its failure is fixed, or another. Every
script still on the revoked release stays refused for pushes and serves until that rollout reaches
it. The revoke response says so.

**Rejected alternatives.**

- *Approval is a reviewed change to this repo.* That is today's model, with the costs of §2.
- *Approval is implied by an upload made by a person* (the unpinned proposal of #2298). D-63's
  first reason stands against it.
- *Approval by the automation token.* Refused by D-63.
- *Approval per driver, so that any release of an approved driver runs.* This approves bytes
  nobody has seen.
- *Approval per digest only.* The same bytes under another driver id run another class and
  another catalog, next to other data.
- *Approval as an entitlement* (control-plane.md §4.3). Entitlements are per tenant. A driver
  release runs for every tenant of every vertical that declares the driver.
- *A directory table of which release each script runs, for the revoke guard.* It is a second
  record beside each script's settings. It needs a pending and a confirmed column, a
  reconciliation before every upload, and a backfill. The revoke is rare, and walking the settings
  under the hold reads the record the ensurer itself trusts (Q15).

### 4.3 When an approval takes effect

An approval takes effect when it is written. It does not wait for a deploy. That is the point of
the proposal, and it is also its risk: nothing between the approval and a rollout is a second
review. D-63 calls the control-plane deploy part of what it trusts. This proposal trusts the staff
sign-in that writes an approval instead. A second person is not required (Q3). The canary runs at
rollout, not at approval (Q10).

### 4.4 What stays in this repo

The **driver id** stays registered in source, with its isolation basis (§6). The **per-release
facts** move to the approval (Q2).

- **The driver id stays in source**, because it is vocabulary and a gate. A vertical declares
  `driver: 'graph'`, and `scopeStoreNeed` holds the id as a literal. The CLI's push check
  (`assertScopeStoresRegistered`) runs inside a released CLI and cannot read the control plane's
  directory. Above all, `mayHoldScopeStores` arms backup, wipe and erasure the moment any driver
  is registered. A registration that lands, and is deployed, before any release is approved arms
  those gates before any store can hold data. That is the order D-63 already wants.
- **The class name, the operation catalog and the `schema` move to the approval**, because they
  are facts about one release of the other project. A release can rename its class or grow its
  catalog. The reserved operations stay the platform's requirement, held in source as
  `RESERVED_STORE_OPERATIONS` and asserted by the canary at every rollout.
- **Schema change** *(proposed)*: `storeDriverRegistration` loses `releases` (it is `.min(1)`
  today), and `className`, `operations` and `platformOperations` with it. What is left is the
  driver id and the isolation basis of §6. `platformOperations` is the field that today holds a
  registration to answering every reserved operation, `substrat.erase` included. Dropping it
  loses nothing, because the canary asserts every entry of `RESERVED_STORE_OPERATIONS` at every
  rollout, before any vertical moves. That check runs on the bytes, which a declaration does not.

**Rejected alternative:** *the whole registration as data.* Then the CLI's push check, the
erasure gate and the upload plan would all depend on a directory read. A released CLI could not
read it, and a control plane that cannot read it would have to guess.

## 5. The existing `STORE_DRIVERS` pins

**There are none on `main`.** `STORE_DRIVERS` is `[]` and the contracts suite asserts it. The only
pin ever written is #2394's, whose bytes the current module rule refuses (§2, problem 1).

**Decided (Q8):** #2394 lands the graph driver id only and drops its pin. Its registration carries
the isolation basis of §6, so it lands at §8 step 6, after the readers have switched, and only
with the decision record that lifts D-63's isolation sentence for the graph driver (Q5). The
graph driver's first release goes through upload and approval.

So no compiled pin has to be carried over. If one merged anyway before the switch, this plan
would stop and be revisited, not reconciled. Two ways of carrying one over were considered and
rejected. *Importing it as an approval row* would be the one approval with no person, no isolation
review and no source references. *Keeping compiled pins as a floor beside the data* gives two
sources of truth, and a control plane that reads only the pin would ignore every revocation (§8).

### 5.1 The D-63 sentences an amendment would change

An amendment is a new decision record with `amends: [D-63]`. It is not written here. The
sentences below are quoted from D-63 as ratified, each followed by proposed replacement text.

1. Lead paragraph. *"It is registered in this repo, and a release of it runs only once this repo
   pins it."*
   → *"It is registered in this repo. A release of it runs only once a person on the platform's
   staff has approved that release for that driver in the control plane, the approval has not
   been revoked, and the driver's registration in this repo still carries an isolation basis
   that admits it."*
2. Lead paragraph. *"The registration names the kind, the script, the class and the operation
   catalog."*
   → *"The registration names the driver. The platform names each store script, as it does today
   (`scopeStoreScriptName`). The approval of a release names the class and the operation catalog
   of that release."*
3. *"A release is identified by two values: the sha256 of the release bundle, and the source commit
   the bundle was built from. Both are recorded in the registration, or in an allowlist file the
   registration names."*
   → *"A release is identified by the sha256 of its bundle, which the platform computes when the
   bundle is uploaded. The approval records the source references (repository and commit) the
   approver reviewed; the platform does not check them against the bytes."*
4. *"The bytes do not have to live in this repo, and they may be published to the platform before
   the pin lands. The platform runs a release only once its sha256 and its source commit are
   pinned here by a reviewed change. A review of that change is the review of what the platform
   will run for every tenant."*
   → *"The bytes are uploaded to the platform, which stores them by their sha256. An upload does
   not make a release runnable. The platform runs a release only once it is approved, and the
   review behind the approval is the review of what the platform will run for every tenant."*
5. *"It has to show the envelope, the reserved operations (including `substrat.erase`), and no
   per-object state at module level."* Unchanged, except that "It" now means the review behind
   the approval.
6. Python paragraph. *"The two values of the pin vouch for different bytes. The source commit
   vouches for the driver package and for the pyproject/lock its dependencies were installed
   from."* → *"The sha256 vouches for every byte. The source references an approval records name
   the driver package, every dependency built from a repository, and the pyproject/lock a reviewer
   read."* The same paragraph's *"The upload says so for every release that carries one, pinned or
   not"* → *"…, approved or not"*.
7. Why. *"The source commit names the code a reviewer reads."* → *"The source references an
   approval records name the code the reviewer read."*
8. Why. *"A person publishing, a canary over every reserved operation, and a rollback to the last
   good release keep a reviewed release from reaching tenants by any other path."* → *"A person
   approving, separately from the upload, a canary over every reserved operation, and a rollback
   to the last good release keep a reviewed release from reaching tenants by any other path."*
9. Why, *"Considered: unpinned releases"*. Unchanged, followed by one added paragraph: the
   amendment answers the first reason (a person approves, as a separate write) and the second
   (provenance is the approver's recorded review, not the digest). It keeps the second half of
   the third: the review of each release stays the only control until the isolation above
   exists. It overturns the first half on purpose: a recorded review in the control plane stands
   where a reviewed change in this repo stood, while the isolation gate itself stays a reviewed
   change in this repo.
10. Limits. *"What the platform checks is the bundle's sha256, at registration and at every
    upload of the script."* → *"…, when the release is uploaded and at every upload of the
    script."* (The approve route hashes nothing. It names a sha256 the platform computed at
    upload.) The same bullet's *"…they re-hash the stored bytes they are about to send and compare
    them with the pin, rather than trusting a hash taken when the bytes arrived"* → *"…compare them
    with the approved sha256, rather than…"*.
11. Limits. **"Pins are never removed."** The whole bullet (*"A superseded release, including one
    superseded for a defect, stays pinned, so a holder of the publishing credential can publish it
    again. An explicit way to revoke or withdraw a pinned release, after which it does not run, is
    a follow-up."*) → **"An approval can be revoked."** *"Revoking an approval stops every later
    upload of that release, a rollback to it included. It is refused while a script runs the
    release, unless a person passes an emergency flag with a reason. It does not stop a script
    that already runs the release; a rollout moves that script. Approvals and their revocations
    are kept and never deleted."*
12. Why. *"No kind written outside this repo (a third-party kind) is registered until that
    isolation exists."* → *"A kind written outside this repo (a third-party kind) is registered
    only with an isolation basis that names a decision record lifting this requirement for it.
    Without one its registration is refused, and no release of it is approved."* This keeps the
    gate at registration, where D-63 put it, and states that the approve route reads the same
    basis (§6).
13. Limits. **"The allowlist takes effect at control-plane deploy."** The whole bullet → **"An
    approval takes effect when it is written."** *"The driver's registration, its id and its
    isolation basis, is compiled into the control plane and takes effect at control-plane deploy.
    An approval is data and takes effect at once. The staff sign-in that writes it is part of what
    this decision trusts."*

Everything else in D-63 is unchanged. That includes "a release is published by a person", the
canary, the rollback target, the module rule, one script per (driver, vertical), and the
condition that defines isolation ("a separate script per tenant, no outbound access, and
verification of the envelope outside the kind's reach"). Only its consequence for registration is
restated, in item 12. The mirrored rows in master-plan §12 are rendered from the record, so the
amendment changes them through `lint:decisions`. The prose that describes the pin would follow the
decision: [scope-stores.md](./scope-stores.md) step 8,
[control-plane.md](../architecture/control-plane.md) §4.4, `apps/docs/concepts/scope-stores.md`,
and the doc comments on `storeDriverRegistration` and `STORE_DRIVERS`.

## 6. The isolation requirement stays a gate

D-63 says that until a driver cannot affect data outside the object it serves by construction,
the review of a release is the control that stands between it and every tenant. By construction
means a separate script per tenant, no outbound access, and verification of the envelope outside
the driver's reach. It also says *"No kind written outside this repo (a third-party kind) is
registered until that isolation exists."* None of that depends on where an approval is stored.
Moving the approval from source to data neither meets the requirement nor weakens it. This RFC
makes no claim about whether any driver, the graph driver included, meets it.

**The graph driver is written outside this repo** (Q5). So D-63's sentence gates it: its
registration, and therefore its first approval, wait for a decision record that lifts the
requirement for it. Nothing in this RFC is that record.

Both halves of the requirement stay mechanical:

- **The gate on whether a third-party driver may be approved at all stays in source.** The
  registration carries an isolation basis *(proposed field)*. It is either "written in this repo",
  or a reference to the decision record that lifts D-63's sentence for that driver. A
  registration of a driver written outside this repo is refused unless its basis names such a
  record (§5.1, item 12), and the approve route reads the same basis. Lifting the requirement
  therefore stays a reviewed change in this repo, with a decision record behind it, as D-63 has
  it. Only the per-release approval moves to data.
- **The basis is per driver, and each approval is held to it.** Source references are per
  approval (§7), so one release could claim a basis it does not have. The approver lists the
  driver package and **every dependency built from a repository** (Q16). A dependency resolved
  from a public package index is install output, which D-63 already vouches for by the sha256
  alone, and is not listed. With the basis "written in this repo", the approve route refuses (422)
  an approval any of whose source references names another repository *(proposed)*. So a release
  that carries a dependency built from another repository, like the one #2394's bundle carries,
  needs a basis that names a lifting record. The check is only as good as the list: an approver
  who leaves a repository out is not caught by it, and the review is what catches that.
- **The basis is checked wherever an approval is read, not only when it is written.** The
  rollout, the rollback, the ensurer and the fleet rebuild treat an approval as live only while
  the compiled registration still carries an isolation basis that admits it. So if a later
  reviewed change removes a driver's basis, its approvals stop counting at the next control-plane
  deploy, without a revoke. That keeps "lifting the requirement is a reviewed change in this repo"
  true in both directions. The cost is §4.2's: every push and serve of a vertical whose script runs
  such a release is refused until the basis returns. Removing a basis is therefore a deliberate
  stop, the same as an emergency revoke of every release of the driver.
- **Each approval records the review against the requirement.** The approve request carries a
  required isolation review *(proposed)*. For each of D-63's three conditions it records whether
  the reviewer found it met, with a reference to the evidence. It also records that the reviewer
  checked the release's envelope handling, its reserved operations and the absence of per-object
  state at module level, the review D-63 requires (§5.1, item 5). The route refuses an approval
  with any condition **missing**. It never infers a condition from the bytes.
- **A condition recorded "not met" is recorded, and does not refuse** (Q14). Until the isolation
  exists, every driver fails at least one of D-63's three conditions, including a driver written
  in this repo. D-63 does not stop a driver written in this repo from running for that reason: it
  makes the review the control instead. Refusing "not met" would block every approval of every
  driver until the isolation exists. So the answer is stored and shown in `status`, and it
  refuses nothing. Whether a driver written outside this repo may be approved at all is decided
  by the isolation basis gate above, and by nothing else.

**Rejected alternatives.**

- *A free-text reason only.* That records that someone approved, not what they checked against.
- *Refuse any approval with a condition marked "not met".* This is stricter than D-63 and would
  refuse every approval, of drivers written in this repo too, until the isolation exists.

## 7. Reproducibility: what the digest and the commit mean

**The digest vouches for bytes and nothing else.** `storeDriverReleaseDigest` frames the tag
`substrat.store-release/v1`, the entry, and each module's name, length and exact bytes. It
says nothing about where the bytes came from. D-63's first limit already says so, and §2 problem 2
is that limit seen in practice.

**`sourceCommit` is the uploader's claim.** On the upload, the CLI's `sourceCommitOf` checks that
the driver package is clean and tracked at `HEAD` of the checkout `--dir` is in. It does not check
`python_modules/`. When the uploader passes `--commit`, the CLI skips `sourceCommitOf` altogether
(`flag('commit') ?? sourceCommitOf(dir, files)` in `packages/cli/src/cli.ts`), so the stored
commit is whatever was typed. The platform checks nothing about the commit either way.

**The approval records a structured list of source references** (Q6) *(proposed)*: each a
(repository, commit) the approver says they read, the driver package and every dependency built
from a repository (§6). A bundle like #2394's, with a dependency built from a second repository,
then names both. The platform stores the list and parses only its shape. It is not a build input
the platform can replay. The upload's single `sourceCommit` stays as it is on the wire.

**Excluding installer-written `*.dist-info` files is deferred** (Q7). A Python installer writes
files into each distribution's `*.dist-info/` beside its metadata, some of which depend on the
machine and the time. When this is done, the packer drops them and the upload refuses them, as it
refuses `.pth`, `pyvenv.cfg` and `.synced` today (`PYTHON_VENDORED_FILES`). The framing does not
change, so no new tag is needed. Letting the digest skip them while the bundle still carries them
is rejected: bytes that are uploaded and run would escape the digest. It waits for three reasons:

1. **It may break a dependency.** A package can read its own metadata at import time, through
   `importlib.metadata`. Which files the runtime reads has to be measured first, with the
   existing runtime probe (`packages/store-entry-python/probe.mjs`).
2. **It does not make a build reproducible by itself.** Wheel builds, compiled extensions and the
   versions an installer resolves vary too. Reproducibility comes from the controlled build of
   §4.1.
3. **The pressure goes away.** Under approval, a digest that cannot be reproduced costs one more
   upload and one more approval. It does not cost a permanent pin.

When it is done, it is a module-rule change, so a stored release that the stricter rule refuses
stops being runnable, and `status` says so.

## 8. Migration order and backward compatibility

**Order.** Each step is its own pull request, and none starts before step 1. The summary's five
steps group these seven.

1. **The decision.** A decision record amends D-63 with the sentences of §5.1. Nothing below lands
   before it.
2. **The vocabulary.** The two new admin actions are added to `adminAction`, and the response
   fields of step 4 are added to the client types, in a release before any code writes them.
   `adminAction` is a closed `z.enum`. A control plane rolled back below the release that added a
   name would meet log rows it does not name. K-53's rename kept its old names readable as
   `HISTORIC_ADMIN_ACTIONS` for the same reason.
3. **The directory.** `store_driver_approvals` and `store_driver_revoke_walks` *(both proposed)*
   join `STORE_DRIVER_RELEASES_DDL`, on both adapters, under `lint:spine-ddl`. The `HostAdmin`
   verbs to approve, revoke and read *(proposed)* are audited. Nothing reads approvals yet, and the
   ensurer writes nothing new.
4. **Routes, CLI and the isolation basis.** Approve, revoke and status, all *(proposed)*. The
   isolation basis joins `storeDriverRegistration` here as a field (§6), so the approve route can
   read it from its first release. Released CLIs keep working. `upload` and `rollout` keep their
   routes and bodies. The upload response keeps `pinned`, which a released CLI reads
   (`packages/cli/src/cli.ts`), and from step 5 it means "approved for this driver and not
   revoked". A new `approved` field carries the same value, and a new CLI reads that. A released
   CLI then prints *"not pinned yet: it runs once a reviewed change pins this sha256 and commit"*
   until approval. That is safe, but it **misleads**: it sends the uploader to open a pin change
   in this repo. The CLI release that adds `approve` changes that line, and the upload route's
   documentation says to upgrade the CLI. `GET /store-drivers/:driver` keeps `pins` in its current
   shape, `{ sha256, sourceCommit, schema }`, holding the releases with a live approval.
   `sourceCommit` there is the upload's, and the approval's source references go in a new field
   beside it *(proposed)*, so a released reader is not handed a shape it cannot parse.
5. **The switch.** Every reader of `registration.releases` and `registration.className` moves to
   the approval in one pull request: `pinOf`, `assertSchemaKept`, `GET /store-drivers/:driver`
   (`pins`), the upload's `pinned`, `scopeStoreUploadPlan`, the ensurer and the canary ensurer
   (`createStoreCanaryEnsurer`), and both roles of `schemaOf` in `store-releases.ts` (§4.2). The
   class name reaches `withPythonStoreEntry` from the target's approval, through the loader. The
   approvals a plan or a walk needs are read once per rollout request, push, serve or rebuild
   pass, and handed to the ensurer the way `releases` is handed to it today, not read once per
   script *(proposed)*. A push or serve of a vertical that declares no store reads nothing new.
   `releases` and `className` leave the registration schema in this same pull request, so no
   control-plane release reads both pins and approvals. `STORE_DRIVERS` is still empty, so nothing
   can run, and every gate behaves as it does today.
6. **The registration.** A driver is registered as its id plus its isolation basis (§4.4, §6).
   That arms `mayHoldScopeStores` and the push checks, with every reader already on approvals. A
   CLI release carries it, because the CLI's push check is compiled in. For `graph` (#2394, Q8),
   the basis names the decision record that lifts D-63's isolation sentence for it, so this step
   waits for that record (Q5).
7. **The first approval and the first rollout.** An approval needs a registration and its
   isolation basis to read, so it can be written once the step-6 deploy serves. Approving is never
   gated on a deploy finishing, because it makes nothing run by itself. The gate is on the **first
   rollout after the step-6 deploy**, once. The rollout route refuses until a person attests that
   this deploy has finished rolling out (below) *(proposed)*. Later control-plane deploys do not
   re-arm the gate, because they do not change which releases a version admits. A deploy that did
   change that would arm it again.

**Released control planes and the sha256 gate.** The control plane deploys gradually, so for a
while an older version serves beside the new one. `store-rebuild.ts` already allows for this with
its settle window (`STORE_REBUILD_SETTLE_MS`) and the person's `--deploy-finished` attestation.
During the step-6 overlap, the older version does not know the driver at all: `registeredDriver`
in `api.ts`, `scopeStoreUploadPlan` and the push check `assertScopeStoresRegistered` answer 403,
"is not registered". **It fails closed**: no release the older version has not seen runs through
it. The cost is that a push or rebuild that the older version serves during the overlap fails.
That is why step 7's gate holds the first rollout until the step-6 deploy has finished.

Three consequences:

- **No compiled pin may sit beside approvals.** An older version reads a compiled pin and no
  revocation. If the same sha256 were both pinned and revoked, an older version would still run
  it. This is why step 5 removes `releases` in the same pull request that switches the readers,
  and why §5 drops #2394's pin.
- **The directory read is new on the push path.** Today the pin check is an in-memory lookup.
  After step 5, a push or serve of a vertical that declares a store reads the approvals once, and
  a read that fails refuses the push (503) rather than guessing. Nothing is cached (Q13). The cost
  is that a directory outage now also stops pushes of store-declaring verticals.
- **The registration is a floor for control-plane rollback.** A control plane rolled back below
  the release that registered the driver sees `STORE_DRIVERS` empty. There, `mayHoldScopeStores`
  answers that no scope holds a store, and backup, wipe and erasure skip stores that do hold data.
  Pins have the same property today. An approval-based flow makes that version easier to forget,
  so the runbook names it: once a store holds data, the control plane is not rolled back below the
  release that registered its driver.

## 9. Decided questions

The maintainer decided each of these on 2026-10-19. The reasoning is kept, so the amendment can
cite it.

- **Q1. The hinge.** Does a recorded approval in the control plane, made by a person with a staff
  sign-in and carrying the isolation review of §6, stand in for "a reviewed change in this repo",
  D-63's third reason against #2298? **Decided: yes.** *Why:* the review of each release stays the
  only control until isolation exists, and it is still a person's review of the exact bytes. What
  moves is where it is recorded, and the isolation gate itself stays a reviewed change in this
  repo (§3, §6).
- **Q2. The split.** **Decided: the driver id stays in source; the class name, the catalog and
  the `schema` move to the approval** (§4.4). *Why:* the id is vocabulary and arms gates that a
  released CLI and the erasure path read without the directory. The other three are facts about
  one release of another project.
- **Q3. Two people.** **Decided: record the uploader and the approver; no two-person rule yet.**
  *Why:* one person holds a staff sign-in today. The rule can be added later without changing the
  record.
- **Q4. Revocation.** **Decided: refuse revoking a release any script still runs, unless a person
  passes an explicit emergency flag and a reason** (§4.2). *Why:* the ensurer checks the target
  before its no-op shortcut, so a revoked running release refuses every push and serve of the
  verticals whose scripts run it. The guard makes that cost a deliberate choice. After an
  emergency revoke of the current release, a failed roll-forward ends `diverged` with no rollback,
  and the way out is forward.
- **Q5. The graph driver.** **Decided: it is written outside this repo.** D-63's isolation
  sentence still gates it: its registration and first approval wait for a decision record that
  lifts the requirement for it. *Why:* where approvals are stored changes nothing about isolation.
  This RFC makes no claim that the requirement is met.
- **Q6. Source references.** **Decided: a structured list of (repository, commit)** (§7). *Why:*
  a bundle can carry more than one source, and the isolation basis check (§6) needs to read which
  repositories are named.
- **Q7. `*.dist-info`.** **Decided: deferred** (§7). *Why:* what the runtime reads has to be
  measured first, the exclusion alone does not make a build reproducible, and approval removes the
  pressure.
- **Q8. #2394.** **Decided: it lands the graph driver id only and drops its pin** (§5). *Why:* its
  pin can never run, and a compiled pin beside approvals would let an older control plane ignore
  a revocation. Because no pin is carried over, this RFC needs no import, no compiled floor and no
  reconciliation.
- **Q9. Expiry.** **Decided: an approval stands until it is revoked.** The module rule's refusal
  is the only automatic stop. *Why:* an expiry tied to the entry or the envelope version would stop
  running releases without a person deciding it.
- **Q10. A canary before approval.** **Decided: the canary runs at rollout only.** *Why:* the
  rollout's canary already runs before any vertical moves, and an approval makes nothing run by
  itself.
- **Q11. Who may read a stored release.** **Decided: staff only.**
- **Q12. Correcting a release's facts.** **Decided: accept fixed facts.** A wrong fact means new
  bytes, and so a new sha256 (§4.2). *Why:* facts that never change on a release are what let the
  release being left be judged from any of its approval rows. The worst case is a mistyped
  `schema` that is too high: every later release must then carry at least that value, because the
  no-lower-schema guard refuses anything below it.
- **Q13. A directory read on the push path.** **Decided: fail closed (503), no caching.** *Why:*
  a cached approval could outlive its revocation.
- **Q14. "Not met".** **Decided: a condition recorded "not met" is recorded and does not refuse**
  (§6). *Why:* refusing would be stricter than D-63 and block every driver, including ones written
  in this repo, until the isolation exists. The isolation basis gate decides whether a third-party
  driver may run.
- **Q15. A second record of which release each script runs.** **Decided: no such table.** The
  revoke guard walks every script's settings under the driver's exclusive hold, paged as a rollout
  is (§4.2). *Why:* each script's own `STORE_RELEASE_VAR` is the record the ensurer trusts, and a
  second one needs a pending column, a reconciliation and a backfill for a rare operation. The
  freeze of a release's facts that the dropped design read from a run record is decided at the
  release's first approval instead (Q12), so no run record is kept either.
- **Q16. A dependency built from another repository.** **Decided: it counts as third-party, and
  it must be listed in the approval's source references** (§6). *Why:* code built from another
  project's repository for the driver is that project's code, whatever directory it is installed
  into. A dependency resolved from a public package index stays install output.
