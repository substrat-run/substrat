---
status: proposed
layer: plan
description: "A question for the maintainer: should a store driver's release run once a person approves its uploaded bytes in the control plane, instead of once this repo pins its sha256? Keeps D-63's person, canary, rollback, schema and isolation rules; moves the per-release pin into a revocable, audited approval keyed by (driver, sha256); keeps the driver id in source. Names the D-63 sentences an amendment would change, without changing them."
---

# RFC: store driver releases are uploaded and approved, not pinned in source

**Status: proposed.** This is a question for the maintainer, with a recommendation. It is not
a decision record. It changes no code, no `STORE_DRIVERS` entry and no D-NNN file. Where it
needs a surface that does not exist, the surface is marked *(proposed)*. Its open questions are
in §9.

Written against `origin/main` at `3f7cd82f8`. References are to files and symbols, not lines.
[#2394](https://github.com/substrat-run/substrat/pull/2394), the graph driver's first pin, is
cited as context only: this RFC neither approves nor refuses it.

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
  `schema`. `runStoreDriverRollout` holds the driver, canaries the release on a platform-owned
  object (`canaryStoreRelease`, every reserved operation), and then moves each vertical.
- **Every upload of a script checks the pin again.** The ensurer behind every upload (push,
  serve, rollout, rollback, the fleet rebuild of `store-rebuild.ts`), `scriptEnsurer` in
  `packages/control-plane-api/src/store-script.ts`, copies the bytes it is about to send,
  hashes them, and refuses a sha256 its registration does not pin. It also refuses to move a
  script to a lower `schema`. This RFC calls that check *the sha256 gate*. It has been in the
  ensurer since #2299.
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

D-63 rejected the unpinned proposal of #2298 for three reasons. This RFC has to answer each of
them:

1. *"It names who may publish but not that a person must."* Here the approval is a write of its
   own, made only by a person (§4.2).
2. *"The sha256 … records what arrived and is no provenance."* That is still true here, and the
   RFC does not claim otherwise (§7). Provenance is the approver's statement of what they
   reviewed, recorded on the approval and not verified by the platform.
3. *"Without a pin, no reviewed change in this repo stands behind a release."* This is the
   reason the proposal overturns, and it does so on purpose: a recorded review in the control
   plane replaces a reviewed change in this repo. Whether that is acceptable is the maintainer's
   call (§9, Q1).

## 4. The proposal

### 4.1 A release is an upload, named by the platform

**Recommended.** A driver release is what `substrat store-driver upload` sends today. The route,
body and CLI stay the same. The platform computes `storeDriverReleaseDigest` when the body
arrives, as `storeDriverRelease()` already does, and stores the bytes and the row keyed by
(driver, sha256), as it already does. Nothing about a release is added to this repo.

Two additions, both *(proposed)*:

- **The stored row describes the release.** Beside `sha256`, `source_commit`, `uploaded_by` and
  `uploaded_at`, the row keeps the entry, the module count, the byte count, and a list of module
  names with each module's own sha256. A reviewer can then see what the digest covers without
  unpacking the bytes. This is derived from the bytes, so it is not a second source of truth.
- **A staff read of a stored release.** A reviewer has to be able to read the exact bytes the
  digest names. Today nothing serves them back. A staff-only read of one stored release *(proposed)*
  returns the manifest above and the bundle as stored.

**Rejected alternatives.**

- *A tool that writes the pin into `STORE_DRIVERS` from an upload.* It still needs a merged
  change and a deploy for every release, and it still puts another project's facts into this
  repo. It automates problem 4 and solves none of the others.
- *An allowlist file that the registration names.* D-63 allows this. It has the same costs as a
  pin in the registration.
- *The platform builds the release from source.* This is the only option that would make
  `sourceCommit` provenance. It needs the platform to fetch another project's source and run its
  installer in a controlled build. That is the long-term answer to §7, the same move as the
  hosted review runner's "later the input of a controlled build"
  ([hosted-review-runner.md](./hosted-review-runner.md), D5). It is too large to wait for, and it
  does not remove the need for an approval.
- *Releases signed by the driver's authors.* This moves trust to a key the platform does not
  hold, and it records nothing about review by the platform's staff. Not now.

### 4.2 Approval is data in the control plane, granted by a person

**Recommended.** A release becomes runnable through an **approval**, a separate write after the
upload, recorded in the control plane's directory.

- **Keyed per digest and per driver.** An approval names one (driver id, sha256). Approving bytes
  for one driver approves nothing for another, even when the bytes are the same. Approving one
  release approves no other release of the driver.
- **Made by a person.** The approve and revoke routes *(proposed)* run `byAPerson`, exactly as
  the upload does: a human staff sign-in, JSON only, same origin, and the service token refused.
- **What the row records** *(proposed table `store_driver_approvals`)*: the driver, the sha256,
  an approval id, who approved and when, a required reason, the commit or commits the approver
  says they read (§7), the isolation review (§6), the release's `schema`, and its class name and
  operation catalog (§4.4). It also records who revoked it, when, and why. Rows are insert-only:
  a revoke sets the revoke columns once, and approving the same release again writes a new row.
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
| approved | `pinOf` 422 when the sha256 is not in `registration.releases`; ensurer 422 the same way | a live (unrevoked) approval for (driver, sha256), read from the directory. A read that fails refuses (503). It never counts as approved |
| commit matches | `pinOf` 422 when the stored commit is not the pinned one | the approval records the stored commit it was granted against, and the check compares the two |
| schema | `assertSchemaKept`, and the ensurer's schema check, read `registration.releases[].schema` | both read the approval's `schema` |
| module rule | `decodeStoreDriverRelease` at upload and when the ensurer loads the bytes | unchanged. A release the current rule refuses does not run, approved or not, and `status` says why |
| rolled out | a rollout or rollback moves a script; a push or serve never moves one | unchanged |

**Revocation** *(recommended semantics)*. Revoking stops every later upload of that release:
a rollout, a rollback to it, a push that would create a script at it, a serve, and the fleet
rebuild. It does not stop a script that already runs the release, because an upload is the only
lever the platform has over a running script. `status` names every script that still runs a
revoked release, and the revoke response names the way out, a rollout to an approved release. A
revoked release is never a rollback target. The rollback answers 422, as an unpinned target does
today (control-plane.md §4.4). The cost of this choice is that a fleet rebuild after a key change
cannot rebuild a script that runs a revoked release. That script keeps the older key lists until
it is rolled forward, and the rebuild reports it as pending, as it reports any script it cannot
rebuild. See Q4.

**Rejected alternatives.**

- *Approval is a reviewed change to this repo.* That is today's model, with the costs of §2.
- *Approval is implied by an upload made by a person* (the unpinned proposal of #2298). D-63's
  first reason stands against it. Uploading and approving are separate acts with separate records,
  so a person who uploads has not approved anything.
- *Approval by the automation token.* Refused by D-63.
- *Approval per driver, so that any release of an approved driver runs.* This approves bytes
  nobody has seen.
- *Approval per digest only.* The same bytes under another driver id run another class and
  another catalog, next to other data.
- *Approval as an entitlement* (control-plane.md §4.3). Entitlements are per tenant. A driver
  release runs for every tenant of every vertical that declares the driver.

### 4.3 Who reads approvals, and when they take effect

An approval takes effect when it is written. It does not wait for a deploy. That is the point of
the proposal, and it is also its risk: nothing between the approval and a rollout is a second
review. D-63 calls the control-plane deploy part of what it trusts. This proposal trusts the staff
sign-in that writes an approval instead. A second person is not required (Q3).

### 4.4 What stays in this repo

**Recommended split.** The **driver id** stays registered in source. The **per-release facts**
move to the approval.

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
  today), and `className` and `operations` with it. What is left is the driver id and the
  isolation basis of §6.

**Rejected alternative:** *the whole registration as data.* Then the CLI's push check, the
erasure gate and the upload plan would all depend on a directory read. A released CLI could not
read it, and a control plane that cannot read it would have to guess. Q2 asks the maintainer to
confirm this split.

## 5. The existing `STORE_DRIVERS` pins

**There are none on `main`.** `STORE_DRIVERS` is `[]` and the contracts suite asserts it. The only
pin ever written is #2394's, which is open, and whose bytes the current module rule refuses (§2,
problem 1). Nothing has to be migrated if this lands first.

**Recommended:** #2394 does not merge its pin. Its registration lands as the driver id alone
(§4.4), and the graph driver's first release goes through upload and approval. Whether the
graph driver may be approved at all is a separate question (§6, Q5).

If a pin has merged by the time this is built, there are two options:

- **(a) Import it once** *(recommended for that case)*. On its first start, the approval-reading
  control plane writes an approval row for each compiled pin. The approver is recorded as the
  reviewed change that added the pin, and the reason as that change's number. A later change then
  removes `releases` from the registration. Only an import is ever written. Nothing reads the
  compiled list as an approval after that.
- **(b) Keep compiled pins as a bootstrap floor, counted as approved beside the data.**
  *Rejected.* That gives two sources of truth. It also keeps "pins are never removed" true for
  those releases, because a revocation in data would have to override a compiled pin, and an
  older control plane, which reads only the pin, would still run the release (§8).

### 5.1 The D-63 sentences an amendment would change

An amendment is a new decision record with `amends: [D-63]`. It is not written here. The
sentences below are quoted from D-63 as ratified, each followed by proposed replacement text.

1. Lead paragraph. *"It is registered in this repo, and a release of it runs only once this repo
   pins it."*
   → *"It is registered in this repo. A release of it runs only once a person on the platform's
   staff has approved that release for that driver in the control plane, and the approval has not
   been revoked."*
2. *"A release is identified by two values: the sha256 of the release bundle, and the source commit
   the bundle was built from. Both are recorded in the registration, or in an allowlist file the
   registration names."*
   → *"A release is identified by the sha256 of its bundle, which the platform computes when the
   bundle is uploaded. The approval records the source commit or commits the approver reviewed;
   the platform does not check them against the bytes."*
3. *"The bytes do not have to live in this repo, and they may be published to the platform before
   the pin lands. The platform runs a release only once its sha256 and its source commit are
   pinned here by a reviewed change. A review of that change is the review of what the platform
   will run for every tenant."*
   → *"The bytes are uploaded to the platform, which stores them by their sha256. An upload does
   not make a release runnable. The platform runs a release only once it is approved, and the
   review behind the approval is the review of what the platform will run for every tenant."*
4. *"It has to show the envelope, the reserved operations (including `substrat.erase`), and no
   per-object state at module level."* Unchanged, except that "It" now means the review behind
   the approval.
5. Python paragraph. *"The two values of the pin vouch for different bytes. The source commit
   vouches for the driver package and for the pyproject/lock its dependencies were installed
   from."* → *"The sha256 vouches for every byte. The commit an approval records names the driver
   package and the pyproject/lock a reviewer read."* The same paragraph's *"The upload says so for
   every release that carries one, pinned or not"* → *"…, approved or not"*.
6. Why. *"A person publishing, a canary over every reserved operation, and a rollback to the last
   good release keep a reviewed release from reaching tenants by any other path."* → *"A person
   approving, separately from the upload, a canary over every reserved operation, and a rollback
   to the last good release keep a reviewed release from reaching tenants by any other path."*
7. Why, *"Considered: unpinned releases"*. Unchanged, followed by one added paragraph: the
   amendment answers the first reason (a person approves, as a separate write) and the second
   (provenance is the approver's recorded review, not the digest), and overturns the third on
   purpose (a recorded review in the control plane stands where a reviewed change in this repo
   stood).
8. Limits. *"What the platform checks is the bundle's sha256, at registration and at every upload
   of the script."* → *"…, at approval and at every upload of the script."*
9. Limits. **"Pins are never removed."** The whole bullet (*"A superseded release, including one
   superseded for a defect, stays pinned, so a holder of the publishing credential can publish it
   again. An explicit way to revoke or withdraw a pinned release, after which it does not run, is
   a follow-up."*) → **"An approval can be revoked."** *"Revoking an approval stops every later
   upload of that release, a rollback to it included. It does not stop a script that already runs
   the release; a rollout or a rollback moves that script. Approvals and their revocations are
   kept and never deleted."*
10. Limits. **"The allowlist takes effect at control-plane deploy."** The whole bullet → **"An
    approval takes effect when it is written."** *"The driver's registration, its id, is compiled
    into the control plane and takes effect at control-plane deploy. An approval is data and
    takes effect at once. The staff sign-in that writes it is part of what this decision trusts."*

Everything else in D-63 is unchanged. That includes "a release is published by a person", the
canary, the rollback target, the module rule, one script per (driver, vertical), and the isolation
sentence. The mirrored rows in master-plan §12 are rendered from the record, so the amendment
changes them through `lint:decisions`. The prose that describes the pin would follow the decision:
[scope-stores.md](./scope-stores.md) step 8,
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

**Recommended:** both halves of the requirement stay mechanical.

- **The gate on whether a third-party driver may be approved at all stays in source.** The
  registration carries an isolation basis *(proposed field)*. It is either "written in this repo",
  or a reference to the decision record that lifts D-63's sentence for that driver. The approve
  route refuses a driver written outside this repo whose registration names no such record.
  Lifting the requirement therefore stays a reviewed change in this repo, with a decision record
  behind it, as D-63 has it. Only the per-release approval moves to data.
- **Each approval records the review against the requirement.** The approve request carries a
  required isolation review *(proposed)*. For each of D-63's three conditions it records whether
  the reviewer found it met, with a reference to the evidence. It also records that the reviewer
  checked the release's envelope handling, its reserved operations and the absence of per-object
  state at module level, the review D-63 requires (§5.1, item 4). The route refuses an approval
  with any condition missing. It never infers a condition from the bytes.

**Rejected alternative:** *a free-text reason only.* That records that someone approved, not what
they checked against.

## 7. Reproducibility: what the digest and the commit mean

**The digest vouches for bytes and nothing else.** `storeDriverReleaseDigest` frames the tag
`substrat.store-release/v1`, the entry, and each module's name, length and exact bytes. It
says nothing about where the bytes came from. D-63's first limit already says so, and §2 problem 2
is that limit seen in practice.

**`sourceCommit` is the uploader's claim and the approver's reference.** On the upload, the CLI's
`sourceCommitOf` checks that the driver package is clean and tracked at `HEAD` of the checkout
`--dir` is in. It does not check `python_modules/`, and the platform checks nothing about the
commit. On the approval, the commit is what the approver says they read. It is not a build input
the platform can replay. **Recommended:** the approval records a list of source references
(repository and commit) instead of one commit *(proposed)*. A bundle like #2394's, with a
dependency built from a second repository, then names both. The platform stores the list and
parses only its shape. The upload's single `sourceCommit` stays as it is on the wire.

**Excluding installer-written `*.dist-info` files: deferred.** A Python installer writes files
into each distribution's `*.dist-info/` beside its metadata. Examples are the record of installed
files, the name of the installer, and where the distribution was installed from. Some of these
depend on the machine and the time. There are two ways to leave them out, and they differ:

- **(i) The packer drops them, and the upload refuses them**, as it refuses `.pth`, `pyvenv.cfg`
  and `.synced` today (`PYTHON_VENDORED_FILES`). The framing does not change, so no new tag is
  needed. The bundle no longer carries those bytes, and the runtime never sees them.
- **(ii) The digest skips them** while the bundle still carries them. That is a framing change
  under a new tag (`substrat.store-release/v2`, as the comment on `STORE_RELEASE_DIGEST_TAG`
  requires). **Rejected:** bytes that are uploaded and run would escape the digest, which breaks
  D-63's "the sha256 names the bytes that run".

(i) is deferred, for three reasons:

1. **It may break a dependency.** A package can read its own metadata at import time, through
   `importlib.metadata`. Which files the runtime reads has to be measured first, with the
   existing runtime probe (`packages/store-entry-python/probe.mjs`), before a rule refuses any of
   them.
2. **It does not make a build reproducible by itself.** Wheel builds, compiled extensions and the
   versions an installer resolves vary too. Reproducibility comes from the controlled build of
   §4.1, and that is where an exclusion belongs.
3. **The pressure goes away.** Under approval, a digest that cannot be reproduced costs one more
   upload and one more approval. It does not cost a permanent pin.

When (i) is done, it is a module-rule change, so §4.2's rule applies to it. A stored release that
the stricter rule refuses stops being runnable, and `status` says so. Under pins, that was §2's
problem 1.

## 8. Migration order and backward compatibility

**Order.** Each step is its own pull request, and none starts before step 1.

1. **The decision.** The maintainer accepts or rejects the amendment of §5.1. Nothing below lands
   before it.
2. **The vocabulary.** The two new admin actions are added to `adminAction`, and the response
   fields of step 4 are added to the client types, in a release before any code writes them.
   `adminAction` is a closed `z.enum`. A control plane rolled back below the release that added a
   name would meet log rows it does not name. K-53's rename kept its old names readable as
   `HISTORIC_ADMIN_ACTIONS` for the same reason.
3. **The directory.** `store_driver_approvals` *(proposed)* joins `STORE_DRIVER_RELEASES_DDL`, on
   both adapters, under `lint:spine-ddl`. The `HostAdmin` verbs to approve, revoke and read
   *(proposed)* are audited. Nothing reads approvals yet.
4. **Routes and CLI.** Approve, revoke and the staff read of a stored release, all *(proposed)*.
   `store-driver status` shows approvals. Released CLIs keep working. `upload` and `rollout` keep
   their routes and bodies. The upload response keeps `pinned`, which a released CLI reads
   (`packages/cli/src/cli.ts`), and from this step it means "approved for this driver and not
   revoked". A released CLI then prints "not pinned yet" until approval, which is out of date but
   safe. `GET /store-drivers/:driver` keeps `pins` in its current shape, holding the approved
   releases.
5. **The registration.** `storeDriverRegistration` becomes the driver id plus the isolation basis
   (§4.4, §6), and `graph` is registered that way. That arms `mayHoldScopeStores` and the push
   checks. A CLI release carries it, because the CLI's push check is compiled in.
6. **The switch.** `pinOf`, `assertSchemaKept` and the ensurer read the approval instead of
   `registration.releases`. From this step on, an approval is what makes a release runnable.
7. **The first approval.** It is written only after step 6's control plane is the only version
   serving (below).

**Released control planes and the sha256 gate.** The control plane deploys gradually, so for a
while an older version serves beside the new one. `store-rebuild.ts` already allows for this with
its settle window (`STORE_REBUILD_SETTLE_MS`) and the person's `--deploy-finished` attestation.
An older version knows only compiled pins. With approvals in data and no compiled pins, that
version's sha256 gate refuses an approved release (422, "not pinned in its registration"), and so
does its `pinOf`. **That fails closed**: no release the older version has not seen runs through
it. The cost is that a push or rebuild that the older version serves during the overlap fails.
So the first rollout of an approved release waits until the deploy has finished. A person
attests that, the same way the rebuild does, and the rollout route refuses until then
*(proposed)*.

Two consequences:

- **No compiled pin may sit beside approvals.** An older version reads a compiled pin and no
  revocation. If the same sha256 were both pinned and revoked, an older version would still run
  it. This is why §5 rejects the bootstrap floor.
- **The registration is a floor for control-plane rollback.** A control plane rolled back below
  the release that registered the driver sees `STORE_DRIVERS` empty. There, `mayHoldScopeStores`
  answers that no scope holds a store, and backup, wipe and erasure skip stores that do hold data.
  Pins have the same property today, since a rollback past the first registration does the same.
  An approval-based flow makes that version easier to forget, so the runbook names it: once a
  store holds data, the control plane is not rolled back below the release that registered its
  driver.

## 9. Open questions for the maintainer

- **Q1. The hinge.** Does a recorded approval in the control plane, made by a person with a staff
  sign-in and carrying the isolation review of §6, stand in for "a reviewed change in this repo",
  D-63's third reason against #2298? If not, the rest of this RFC does not apply, and §2's
  problems need answers inside the pin model: a withdrawal for a pin, and a repack path.
- **Q2. The split.** Should the driver id stay in source while the class name, the catalog and
  the `schema` move to the approval (recommended, §4.4)? Or should more stay in source, such as
  the catalog as a reviewed contract of what a vertical may call?
- **Q3. Two people.** Must the approver be someone other than the uploader? Recommended: record
  both and do not require it for now, and decide again when a second person holds a staff sign-in.
- **Q4. Revocation.** Is §4.2's rule right? A revoke stops every later upload, a rebuild after a
  key change included, and leaves running scripts where they are until they are rolled forward.
  Or should revoking the current release be refused until a rollout has moved every script off it?
- **Q5. The graph driver.** Is the graph driver "written outside this repo" in D-63's sense? If so,
  its first approval waits for the decision record of §6 that lifts the isolation sentence for it.
  This RFC makes no claim that the requirement is met.
- **Q6. Source references.** A structured list of (repository, commit) on the approval
  (recommended, §7), or free text?
- **Q7. `*.dist-info`.** Defer the exclusion until the probe has measured what the runtime reads
  (recommended, §7), or drop and refuse the installer-written files now?
- **Q8. #2394.** Land the graph registration as the driver id only and close its pin (recommended,
  §5), or merge the pin and import it once?
- **Q9. Expiry.** Should an approval lapse when something it was reviewed against changes, such as
  the module rule, the entry, or the envelope version? Or does it stand until revoked, with the
  module rule's refusal as the only automatic stop?
- **Q10. A canary before approval.** Should the approve route run the canary on the release once,
  so that an approval only ever names a release that answered every reserved operation? Or is
  the canary at rollout enough?
- **Q11. Who may read a stored release.** Staff only (recommended), or also the people who
  maintain the driver, through some route other than the staff console?
