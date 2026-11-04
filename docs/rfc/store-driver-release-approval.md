---
status: building
layer: plan
description: "A store driver's release runs once a person approves its uploaded bytes in the control plane, instead of once this repo pins its sha256. The maintainer decided the RFC's sixteen questions on 2026-10-19, and D-65 amends D-63. Steps 1 to 4 are on main, and graph is registered at step 5 under D-67; the first-rollout attestation gate is not built. Keeps D-63's person, canary, rollback, schema and isolation rules; moves the per-release pin into a revocable, audited approval keyed by (driver, sha256); keeps the driver id and its isolation basis in source."
---

# RFC: store driver releases are uploaded and approved, not pinned in source

**Status: building.** The maintainer decided all sixteen questions on 2026-10-19 (§8), and
[D-65](../decisions/D-065-a-store-driver-release-runs-after-a-person-approves-its-uploaded-bytes.md)
is the amendment to D-63 (step 1). Steps 2 to 4 of §5 are on `main`, and step 5 registers
`graph` under [D-67](../decisions/D-067-the-graph-driver-is-admitted-under-a-reviewed-release-isolation-lift.md).
The *(proposed)* marks below were written before those steps and now name built surfaces, except
the first-rollout attestation gate of step 5, which is deferred. Written against `origin/main` at
`3f7cd82f8`, checked again at `71751ace1`.

---

## Summary

[D-63](../decisions/D-063-a-store-kind-is-platform-code-registered-and-pinned-like-a-connector.md)
runs a store driver's release only once this repo pins its sha256 in `STORE_DRIVERS`. The first
pin, [#2394](https://github.com/substrat-run/substrat/pull/2394)'s, showed the costs: the pinned
bytes can never run, they cannot be rebuilt to the same sha256, a pin can never be removed, and
every repack needs a merged change and a deploy. This RFC moves the per-release pin into an
approval recorded in the control plane.

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
6. An approval stands until a person revokes it. Revoking is refused while the release is the
   driver's current good release, or while any script still runs it, unless the person passes an
   emergency flag and a reason.
7. The revoke check walks every script's own settings under the driver's exclusive hold, paged
   as a rollout is. No second record of which release a script runs is kept.
8. The driver id and its isolation basis stay compiled into this repo. A driver written outside
   this repo is registered only with a decision record that lifts D-63's isolation requirement
   for it.
9. The canary over every reserved operation, the rollback to the previous good release, the rule
   against a lower `schema`, and the re-hash before every upload all stay.
10. A failed read of approvals refuses (503). Nothing is cached.

**Decided answers** (one-line reasons in §8).

| | question | decided |
|---|---|---|
| Q1 | Does a recorded approval stand in for D-63's "reviewed change in this repo"? | Yes, when it carries the isolation review |
| Q2 | What stays in source? | The driver id. Class name, catalog and `schema` move to the approval |
| Q3 | Two people? | Record uploader and approver. No two-person rule yet |
| Q4 | Revoking a release a script runs? | Refused unless an emergency flag and a reason are given |
| Q5 | Is the graph driver third-party? | Yes. D-63's isolation sentence still gates it. No claim is made that it is met |
| Q6 | Source references? | A structured list of (repository, commit) |
| Q7 | `*.dist-info` exclusion? | Deferred |
| Q8 | #2394? | Lands the graph driver id only and drops its pin |
| Q9 | Does an approval expire? | No. The module rule's refusal is the only automatic stop |
| Q10 | A canary at approval? | No. At rollout only |
| Q11 | Who reads a stored release? | Staff only |
| Q12 | Correcting a wrong fact? | Not possible. A wrong fact needs new bytes, so a new sha256 |
| Q13 | Approvals read on the push path? | Fail closed (503). No caching |
| Q14 | An isolation condition reviewed "not met"? | Recorded. It does not refuse |
| Q15 | A table of which release each script runs? | Dropped. The revoke guard walks the scripts' settings |
| Q16 | A dependency built from another repository? | Third-party. Listed in the approval's source references |

**Essential for the first implementation:** approvals written only by a person, per (driver,
sha256); a live approval for every move, on every path; leaving a release judged from its
approval facts, revoked or not; revoke with the walking guard and the emergency flag; the
isolation basis in source, checked at registration and wherever an approval is read; `releases`
and `className` removed from the registration in the change that switches the readers; a failed
read refuses; the first rollout waits for the registering deploy. Everything else is in §6's
deferred hardening list.

**Rollout order.**

1. **Decide.** A decision record amends D-63 with §7's sentences.
2. **Vocabulary and directory.** The new admin actions and response fields ship first; the
   approval table and the revoke walk ledger join the directory. Nothing reads them yet.
3. **Routes, CLI and isolation basis.** Approve, revoke and status ship; the registration gains
   its isolation basis field.
4. **The switch.** Every reader of `registration.releases` and `className` moves to approvals in
   one change, and those fields leave the registration.
5. **Register, approve, roll out.** The driver id and its basis are registered. For the graph
   driver, that waits for the decision record lifting D-63's isolation sentence for it. A person
   approves the first release, and the first rollout waits until a person attests that the
   registering deploy has finished.

---

## 1. Today, and what must not change

**Today** (D-63, #2299, #2300, #2312):

- `STORE_DRIVERS` (`packages/contracts/src/deploy.ts`) is a compiled list of
  `storeDriverRegistration`: driver id (only `graph` is admitted), class name, operation catalog,
  reserved operations, and `releases` of `{ sha256, sourceCommit, schema }`, `.min(1)`. It is
  empty on `main`.
- `PUT /store-drivers/:driver/releases` (`api.ts`, `storeDriverRelease()` in
  `store-releases.ts`) decodes the bundle under the module rule, computes
  `storeDriverReleaseDigest`, stores the bytes under `<driver>/<sha256>`, and records the release
  in the insert-only `store_driver_releases` table. The response says whether it is `pinned`.
- A rollout or rollback goes through `pinOf` (stored, pinned, same commit) and `assertSchemaKept`.
  `runStoreDriverRollout` takes the driver's exclusive hold for one request, canaries the release
  on a platform-owned object, and moves each vertical. A larger fleet is paged: the request ends
  `paused`, releases the hold, and the next request continues from `store_driver_rollout_walks`.
  Each request begins a new `store_driver_rollouts` row.
- `scriptEnsurer` (`store-script.ts`) is behind every upload of a script. It re-hashes the bytes
  it sends and refuses an unpinned sha256 or a lower `schema` (*the sha256 gate*). A push or
  serve never moves a script: it creates a missing one at the current good release, and rebuilds
  an existing one at the release it runs, read from the script's own `STORE_RELEASE_VAR`
  (`recorded()`).
- "Is this driver registered" gates the push check (`assertScopeStoresRegistered`),
  `scopeStoreUploadPlan`, and `mayHoldScopeStores`, which arms backup, wipe and erasure for stores.
- Every write runs `byAPerson`: a human staff sign-in, JSON only, same origin, service token
  refused, audited under an `adminAction`.

**What must not change.** A store driver is not a vertical: it runs one script per (driver,
vertical), across every tenant of that vertical, next to their data. So **an upload alone must
never make a release runnable.** These stay exactly as they are: a person publishes; the canary
over every reserved operation; the rollback to the immediately previous good release; no move to
a lower `schema`; the sha256 gate; D-63's isolation requirement.

**D-63's three reasons against unpinned releases (#2298), answered.** (1) A person must publish:
here the approval is its own write, by a person only. (2) The sha256 is no provenance: still true;
provenance is the approver's recorded statement (§4). (3) No reviewed change in this repo stands
behind a release: the review of each release stays the only control until isolation exists, and it
is still a person's review of the exact bytes; what moves is where it is recorded. The isolation
gate itself stays a reviewed change in this repo (§3). The maintainer accepted this (Q1).

## 2. The proposal

### 2.1 A release is an upload, named by the platform

The upload route, body and CLI stay the same. The platform computes the digest on arrival and
stores bytes and row by (driver, sha256), as it already does. Nothing about a release is added to
this repo.

### 2.2 The approval record

*(proposed table `store_driver_approvals`, routes `approve` and `revoke` under `byAPerson`, admin
actions `approveStoreDriverRelease` and `revokeStoreDriverRelease`, CLI `substrat store-driver
approve --driver <id> --sha256 <hex> --reason <text>` and `revoke`.)*

- **Key.** One (driver id, sha256). Approving bytes for one driver approves nothing for another,
  and approving one release approves no other.
- **Columns.** Driver, sha256, approval id, approver, time, a required reason; the source
  references (§4); the isolation review (§3); the release's facts: `schema`, class name,
  operation catalog. Revoke columns: who, when, why, and whether the emergency flag was passed.
  The uploader is already on the release row.
- **Append-only.** The revoke columns are written once, nothing else on a row changes, and no row
  is deleted. Approving again after a revoke writes a new row.
- **At most one live approval per (driver, sha256)**, by a unique index over unrevoked rows. A
  second approval is refused (409).
- **Facts are fixed at the first approval.** A later approval of the same (driver, sha256) must
  carry the same `schema`, class name and catalog, or it is refused (409). A wrong fact needs new
  bytes and a new sha256 (Q12). So every row of a release agrees, and the release a script is
  leaving can be judged from any of them, revoked or not. The worst case is a `schema` approved
  **too low**. It weakens the no-lower guard: a later move to a release whose real schema cannot
  read the data the bad release migrated then passes. New bytes do not repair the scripts already
  on the bad release; only rolling them forward to a correctly approved release does. A `schema`
  approved too high is milder: every later release must carry at least that value. The approve
  response shows the current release's `schema` beside the new one *(proposed)*. That catches a
  value below current, which the no-lower guard would refuse anyway. It does not catch a release
  that raises the schema but is recorded at the current value. Only the reviewer's reading of the
  release's migrations catches that.
- **Its own witness.** The audit log row follows the mutation in a separate write (#1292), so who,
  when and why are columns of the row, not only fields of the log.

### 2.3 What a move checks

Every check fails closed. **A lookup is judged by its role.** The release a script is *leaving*
is read from its approval facts, revoked or not: `assertSchemaKept`'s `from`, the ensurer's
`running` lookup, `restore()`'s `leaving` side. A release a script is *moving to* needs a live
approval: `pinOf`'s target, the ensurer's target (which on a push or serve is the release the
script already runs), the canary ensurer's target, `restore()`'s `returning` side. `schemaOf`
serves both roles today and becomes two reads. Without the split, a revoked running release could
never be left.

| check | today | proposed |
|---|---|---|
| uploaded | `pinOf` 404; ensurer 409 | unchanged |
| approved | sha256 in `registration.releases` (422) | a live approval, under a registration whose isolation basis admits it (§3). A failed read refuses (503), never counts as approved, and is not cached (Q13) |
| commit | `pinOf` 422 on a different commit | not a control. `storeDriverRelease()` already refuses (409) a second commit for a sha256; the approval copies `sourceCommit` as a consistency check |
| schema | `registration.releases[].schema` | the target's from its live approval; the release left from its approval facts |
| class name | `registration.className` | from the target's approval; the loader returns the facts with the bytes, for `withPythonStoreEntry` |
| module rule | at upload and at every load | unchanged. A release the current rule refuses does not run, approved or not (Q9) |
| rolled out | only a rollout or rollback moves a script | unchanged |

The approvals a request needs are read once per rollout request, push, serve or rebuild pass and
handed to the ensurer as `releases` is today, not once per script. A push of a vertical that
declares no store reads nothing new.

### 2.4 Revocation and the revoke walk

**What a revoke does.** It stops every later upload of the release: a rollout or a rollback to it
(422), a push creating a script at it, a serve, the fleet rebuild. It cannot stop a script already
running the release. Because the ensurer checks the target before its no-op shortcut and
`ensureScopeStoresOf` rethrows, **every push and serve of a vertical whose script runs a revoked
release is refused** until a rollout moves that script, and the fleet rebuild cannot rebuild that
script, so it ends `failing`. Those scripts keep the older key lists after a key rotation until a
rollout moves them (#2309). When the revoked release is the current one, a vertical's first push
that declares the driver is refused too, because a new script is created at current. That cost is
why a revoke is guarded.

**Every request reads approvals after it takes its hold** *(proposed)*: a push or serve after its
shared hold, a rebuild pass after its shared `holdStoreDriver`, not after `claimStoreDriverRebuild`
(its lease comes first and excludes no revoke), and a rollout or rollback after its exclusive hold.
Today the rollout and rollback routes in `api.ts` run `pinOf` and `assertSchemaKept` **before**
`runStoreDriverRollout` takes the hold, so the switch (§5 step 4) moves the target's approval
check, and the schema check that reads it, under the hold, or repeats them there. A revoke is
written under the exclusive hold, which no other live hold can coexist with, so a request that
uploads after the revoke has also read it.

**The guard** (Q4, Q15). Without the emergency flag, a revoke is refused (409) while the release
is current, or while any script of the driver runs it. The guard reads each script's own
`STORE_RELEASE_VAR` through `recorded()`, the record the ensurer itself trusts.

- **One page per request, under the exclusive hold** (`holdStoreDriver`, mode `exclusive`), so no
  push, serve, rebuild or rollout uploads a script while the page is read. A page reads at most
  `ROLLOUT_WALKS_PER_REQUEST` verticals from `storeDriverDeclarations`, in slug order. A larger
  fleet answers `paused`, releases the hold, and the same revoke posted again continues. A page
  holds the driver exclusively for its settings reads and renewals only, under the same 10-minute
  lease as a rollout request (`ROLLOUT_HOLD_TTL_MS`), and uploads nothing except the canary move
  below.
- **The hold is held, not assumed.** Each page renews the hold before every settings read, as a
  rollout renews before every upload, and stops without writing if the renewal fails. The revoke
  write itself asserts the exclusive hold (`assertExclusive`, as `beginStoreDriverRolloutIn`
  does). A lapsed hold would let a push interleave, so a lapsed walk writes nothing.
- **Ledger** *(proposed table `store_driver_revoke_walks`, one row per (driver, sha256))*: the
  cursor, the person and reason of the request that began the walk, and the newest
  `store_driver_rollouts` seq when it began. A cursor only, like `store_driver_rebuilds`; it
  records nothing about which release a script runs. A continuation by another person, or with
  another reason, starts the walk again under that person and reason, so the revoke row names who
  saw the whole walk. A continuation with the emergency flag drops the ledger row and is an
  emergency revoke.
- **Why the pages add up.** Between requests a script's release changes only when a rollout or
  rollback request moves it, and each such request begins a new rollout row, `restore()`'s
  returns included; or when a push creates a missing script, which it does at the current good
  release. So each page first refuses if the release is current, and starts again from the first
  vertical if the newest rollout seq has moved. A script an earlier page read as not running the
  release still does not on the last page. A paged rollout that is still moving the fleet
  therefore keeps restarting the walk, and the revoke cannot finish until the rollout does. That is
  the right outcome: while a fleet is moving, "no script runs this release" is not yet a settled
  fact.
- **Fails closed.** An unreadable script's settings, a script that records no release, or a
  declaration `storeDriverDeclarations` lists as `unreadable` refuses the revoke, naming the
  script and the rollout to do first.
- **The canary script on the last page.** Once every vertical has been read and none runs the
  release, the canary script is read. It can run the release after any rollout to it that did not
  end `good`: a canary that failed, or a canary that passed followed by `restore()`, which returns
  verticals and leaves the canary script where it is. If a current good release exists, the revoke
  first moves the canary script back to it, which the canary ensurer allows at any `schema`.
  Without the move, the fleet rebuild, which walks the canary first, would end `failing` on it.
  With no current release (the driver's first rollout failed), the canary script stays where it is
  until a rollout moves it, and the rebuild reports it until then.
- **The write.** Then, still under the hold, the revoke is written and the ledger row removed.
- **The emergency flag** *(proposed)*, with a reason, skips the walk and the canary move. It still
  takes the exclusive hold for its one request and writes under `assertExclusive`. While a
  rollout request or a push holds the driver, the emergency revoke is refused (409) and is posted
  again. Each such request is bounded: a rollout request's batch, or one push's upload, inside the
  10-minute lease. Once the hold is taken, nothing uploads until the revoke is written, and every
  later request reads it (above). A rollout to the release that ended `good` before the hold was
  taken has made it current, and the emergency revoke is then a revoke of the current release, the
  cost the flag accepts. The other choice, re-reading the approval before each upload, was
  rejected: it costs a directory read per script, and it still leaves a gap between that read and
  the upload. After an emergency revoke of the current release, a failed roll-forward cannot
  return to it, so the request ends `diverged`, and the only way out is another rollout to an
  approved release.

### 2.5 What stays in this repo

The **driver id** stays compiled in, with its isolation basis (§3). It is vocabulary
(`scopeStoreNeed` holds it as a literal), a released CLI's push check cannot read the directory,
and `mayHoldScopeStores` arms backup, wipe and erasure the moment a driver is registered, before
any store can hold data. **The class name, the catalog and the `schema` move to the approval**:
they are facts about one release of another project. *(Proposed)* `storeDriverRegistration` loses
`releases`, `className`, `operations` and `platformOperations`. Dropping `platformOperations`
loses nothing, because the canary asserts every entry of `RESERVED_STORE_OPERATIONS`, on the
bytes, at every rollout.

**Rejected alternatives,** in one place:

- *A tool that writes the pin from an upload, or an allowlist file.* Still a merged change and a
  deploy per release, with another project's facts in this repo.
- *The platform builds from source.* The only way a source reference becomes provenance, and the
  long-term answer (as in [hosted-review-runner.md](./hosted-review-runner.md), D5). Too large to
  wait for, and it still needs an approval.
- *Releases signed by the driver's authors.* Trust moves to a key the platform does not hold.
- *Approval implied by a person's upload (#2298), or by the service token.* Refused by D-63.
- *Approval per driver, or per digest only.* The first approves bytes nobody saw; the second runs
  the same bytes as another class next to other data.
- *Approval as an entitlement.* Entitlements are per tenant; a driver release runs for every
  tenant of every vertical that declares it.
- *The whole registration as data.* The CLI's push check, the erasure gate and the upload plan
  would depend on a directory read a released CLI cannot make.
- *A directory table of which release each script runs.* A second record beside the scripts'
  settings, needing a pending column, a reconciliation and a backfill for a rare operation (Q15).

## 3. The isolation requirement stays a gate

D-63: until a driver cannot affect data outside the object it serves by construction (a separate
script per tenant, no outbound access, envelope verification outside its reach), the review of a
release is the control, and *"No kind written outside this repo (a third-party kind) is registered
until that isolation exists."* Where an approval is stored changes none of that. This RFC makes no
claim that any driver meets the requirement.

**The graph driver is written outside this repo** (Q5). Its registration, and so its first
approval, wait for a decision record that lifts the requirement for it. Nothing here is that
record.

- **The basis is in source** *(proposed field)*: "written in this repo", or a reference to the
  decision record that lifts D-63's sentence for that driver. A third-party driver's registration
  is refused without such a record (§7 item 12). Lifting stays a reviewed change in this repo.
- **Each approval is held to it.** The approver lists the driver package and every dependency
  built from a repository (Q16); a dependency resolved from a public package index is install
  output and is not listed. Under "written in this repo", the approve route refuses (422) an
  approval whose source references name another repository. The check is only as good as the
  list; the review catches an omission.
- **Checked wherever an approval is read.** The rollout, rollback, ensurer and rebuild count an
  approval as live only while the compiled registration's basis admits it. Removing a basis stops
  the driver's approvals once the deploy has finished, with the same cost as an emergency revoke
  of all of them. During the deploy's overlap it does not fail closed (§5).
- **The isolation review is required.** For each of D-63's three conditions the approval records
  whether the reviewer found it met, with evidence, and that they checked envelope handling,
  reserved operations and no per-object state at module level. A missing condition refuses. A
  condition recorded "not met" is recorded and does not refuse (Q14): today every driver fails at
  least one, and D-63 makes the review the control for a driver written in this repo.

## 4. Source references and reproducibility

The digest vouches for bytes and nothing else. `sourceCommit` is the uploader's claim:
`sourceCommitOf` checks only the driver package, and `--commit` skips it (`flag('commit') ??
sourceCommitOf(dir, files)` in `packages/cli/src/cli.ts`). The approval therefore records a
**structured list of (repository, commit)** the approver read (Q6) *(proposed)*: the driver
package and every dependency built from a repository. The platform parses only its shape and
replays nothing. The upload's single `sourceCommit` stays on the wire.

**Excluding installer-written `*.dist-info` files is deferred** (Q7). When it is done, the packer
drops them and the upload refuses them, as `PYTHON_VENDORED_FILES` does for `.pth`; letting the
digest skip bytes that run is rejected. It waits because a package may read its own metadata at
import time (to be measured with `packages/store-entry-python/probe.mjs`), because it does not make
a build reproducible by itself, and because under approval an irreproducible digest costs one
upload and one approval, not a permanent pin.

## 5. #2394 and the rollout order

**#2394** (Q8) lands the graph driver id and its isolation basis only, and drops its pin, whose
bytes the current module rule refuses. It lands at step 5 below, after the lifting record: an
id-only registration does not parse before step 4 removes `releases` from the schema. `STORE_DRIVERS` was empty until step 5, so no compiled pin is
carried over: no import, no compiled floor, no reconciliation. If a pin merged before the switch,
this plan would be revisited.

**Order**, one pull request per step:

1. **Decide.** The D-63 amendment (§7). Nothing below lands before it.
2. **Vocabulary and directory.** The two admin actions join `adminAction` (a closed `z.enum`; a
   control plane rolled back below the name would meet log rows it cannot read, as K-53's
   `HISTORIC_ADMIN_ACTIONS` shows), and the new response fields join the client types, in a
   release before anything writes them. `store_driver_approvals` and `store_driver_revoke_walks`
   join `STORE_DRIVER_RELEASES_DDL` on both adapters, under `lint:spine-ddl`.
3. **Routes, CLI and basis.** Approve, revoke and status. The isolation basis joins
   `storeDriverRegistration`. Released CLIs keep working: the upload response keeps `pinned`,
   meaning "approved and not revoked" from step 4, beside a new `approved`; `GET
   /store-drivers/:driver` keeps `pins` as `{ sha256, sourceCommit, schema }` of the live
   approvals, with source references in a new field. A released CLI's "not pinned yet" line
   misleads until upgraded, so the CLI that adds `approve` changes it.
4. **The switch.** Every reader of `registration.releases` and `className` moves in one pull
   request: `pinOf`, `assertSchemaKept`, `GET /store-drivers/:driver`, `pinned`,
   `scopeStoreUploadPlan`, the ensurer, `createStoreCanaryEnsurer`, both roles of `schemaOf`. The
   fields leave the schema in the same pull request, so **no control-plane release reads both pins
   and approvals**: an older version reads a pin and no revocation. `STORE_DRIVERS` is still
   empty, so nothing runs yet.
5. **Register, approve, roll out.** A driver is registered as id plus basis, in a CLI release too,
   because the push check is compiled in; for `graph` this waits for the lifting record (Q5).
   Approvals can be written once that deploy serves. The **first rollout after it** is refused
   until a person attests that the deploy has finished *(proposed, deferred: not built with the
   graph registration, so the first approval and rollout wait by hand)*: during the overlap the older
   version answers 403 "is not registered", which fails closed but fails pushes it serves. Later
   deploys do not re-arm the gate unless they change which releases a version admits.

**Hazards for the runbook.**

- After step 4, a directory outage also stops pushes of store-declaring verticals (503, Q13).
- Once a store holds data, the control plane is never rolled back below the release that
  registered its driver: there `mayHoldScopeStores` answers that no scope holds a store, and
  backup, wipe and erasure skip stores that do.
- **Removing an isolation basis does not fail closed while it deploys.** Until the deploy has
  finished, an older version still serves with the basis and keeps admitting the driver's
  approvals for pushes, serves and rebuilds. A basis removed to stop a driver at once is therefore
  paired with an emergency revoke of each of its approved releases, which takes effect on every
  version immediately because approvals are data.

## 6. Deferred hardening

Each of these can follow the first implementation without weakening a decided answer:

- **A manifest on the stored release row**: entry, module count, byte count, each module's name
  and sha256, so a reviewer sees what the digest covers without unpacking.
- **A staff read of a stored release** (Q11). Until it exists, the approver reviews the bundle they
  hold and compares its `storeDriverReleaseDigest` with the stored sha256.
- **`restore()`'s own branch for a revoked `from`.** Today the missing `returning` schema already
  ends the request `diverged` with nothing returned, but the detail blames a schema drop. The
  branch gives the right reason and names which verticals are on which release.
- **`status` naming every script that still runs a revoked release**, and the revoke response
  naming the rollout that clears it.
- **The canary after an emergency revoke.** An emergency revoke skips the canary move, and when
  the revoked release was current there is no approved release to move the canary script to. Until
  the next rollout moves it, the fleet rebuild ends `failing` on it.
- **A two-person rule** (Q3), once a second person holds a staff sign-in.
- **The `*.dist-info` exclusion** (Q7) and **a controlled build from source** (§4).

## 7. The D-63 sentences an amendment would change

An amendment is a new decision record with `amends: [D-63]`. It is not written here. Each quoted
sentence is followed by proposed text.

1. Lead. *"It is registered in this repo, and a release of it runs only once this repo pins it."*
   → *"It is registered in this repo. A release of it runs only once a person on the platform's
   staff has approved that release for that driver in the control plane, the approval has not
   been revoked, and the driver's registration in this repo still carries an isolation basis
   that admits it."*
2. Lead. *"The registration names the kind, the script, the class and the operation catalog."*
   → *"The registration names the driver. The platform names each store script, as it does today
   (`scopeStoreScriptName`). The approval of a release names the class and the operation catalog
   of that release."*
3. *"A release is identified by two values: the sha256 of the release bundle, and the source commit
   the bundle was built from. Both are recorded in the registration, or in an allowlist file the
   registration names."* → *"A release is identified by the sha256 of its bundle, which the
   platform computes when the bundle is uploaded. The approval records the source references
   (repository and commit) the approver reviewed; the platform does not check them against the
   bytes."*
4. *"The bytes do not have to live in this repo, and they may be published to the platform before
   the pin lands. The platform runs a release only once its sha256 and its source commit are
   pinned here by a reviewed change. A review of that change is the review of what the platform
   will run for every tenant."* → *"The bytes are uploaded to the platform, which stores them by
   their sha256. An upload does not make a release runnable. The platform runs a release only once
   it is approved, and the review behind the approval is the review of what the platform will run
   for every tenant."*
5. *"It has to show the envelope, the reserved operations (including `substrat.erase`), and no
   per-object state at module level."* Unchanged, except that "It" now means the review behind
   the approval.
6. Python. *"The two values of the pin vouch for different bytes. The source commit vouches for
   the driver package and for the pyproject/lock its dependencies were installed from."* → *"The
   sha256 vouches for every byte. The source references an approval records name the driver
   package, every dependency built from a repository, and the pyproject/lock a reviewer read."*
   And *"The upload says so for every release that carries one, pinned or not"* → *"…, approved or
   not"*.
7. Why. *"The source commit names the code a reviewer reads."* → *"The source references an
   approval records name the code the reviewer read."*
8. Why. *"A person publishing, a canary over every reserved operation, and a rollback to the last
   good release keep a reviewed release from reaching tenants by any other path."* → *"A person
   approving, separately from the upload, a canary over every reserved operation, and a rollback
   to the last good release keep a reviewed release from reaching tenants by any other path."*
9. Why, *"Considered: unpinned releases"*. Unchanged, plus one paragraph: the amendment answers
   the first reason (a person approves, as a separate write) and the second (provenance is the
   approver's recorded review, not the digest). It keeps the second half of the third: the review
   of each release stays the only control until the isolation exists. It overturns the first half
   on purpose: a recorded review in the control plane stands where a reviewed change in this repo
   stood, while the isolation gate itself stays a reviewed change in this repo.
10. Limits. *"What the platform checks is the bundle's sha256, at registration and at every upload
    of the script."* → *"…, when the release is uploaded and at every upload of the script."* And
    *"…compare them with the pin, rather than trusting a hash taken when the bytes arrived"* →
    *"…compare them with the approved sha256, rather than…"*.
11. Limits. **"Pins are never removed."** The whole bullet → **"An approval can be revoked."**
    *"Revoking an approval stops every later upload of that release, a rollback to it included.
    It is refused while the release is the driver's current good release or a script runs it,
    unless a person passes an emergency flag with a reason. It does not stop a script that already runs the release; a rollout moves that script.
    Approvals and their revocations are kept and never deleted."*
12. Why. *"No kind written outside this repo (a third-party kind) is registered until that
    isolation exists."* → *"A kind written outside this repo (a third-party kind) is registered
    only with an isolation basis that names a decision record lifting this requirement for it.
    Without one its registration is refused, and no release of it is approved."*
13. Limits. **"The allowlist takes effect at control-plane deploy."** The whole bullet → **"An
    approval takes effect when it is written."** *"The driver's registration, its id and its
    isolation basis, is compiled into the control plane and takes effect at control-plane deploy.
    An approval is data and takes effect at once. The staff sign-in that writes it is part of what
    this decision trusts."*

Everything else in D-63 is unchanged, including the condition that defines isolation. The
master-plan §12 rows follow through `lint:decisions`. The prose describing the pin follows the
decision: [scope-stores.md](./scope-stores.md) step 8,
[control-plane.md](../architecture/control-plane.md) §4.4, `apps/docs/concepts/scope-stores.md`,
[graph-store-registration.md](./graph-store-registration.md), and the doc comments on
`storeDriverRegistration` and `STORE_DRIVERS`.

## 8. Decided questions

Decided by the maintainer on 2026-10-19.

- **Q1. Yes**, a recorded approval carrying the isolation review stands in for "a reviewed change
  in this repo". *Why:* the review of the exact bytes stays the only control; only where it is
  recorded moves, and the isolation gate stays in this repo.
- **Q2. The driver id stays in source; class name, catalog and `schema` move to the approval.**
  *Why:* the id arms gates a released CLI and the erasure path read without the directory.
- **Q3. Record the uploader and the approver; no two-person rule yet.** *Why:* one person holds a
  staff sign-in today, and the record allows the rule later.
- **Q4. Refuse revoking a release any script runs, unless an emergency flag and a reason are
  given.** *Why:* a revoked running release refuses every push and serve of those verticals.
- **Q5. The graph driver is written outside this repo**; D-63's isolation sentence gates it, and
  no claim is made that it is met. *Why:* where approvals live changes nothing about isolation.
- **Q6. A structured list of (repository, commit).** *Why:* a bundle can have several sources,
  and the basis check reads the repositories.
- **Q7. The `*.dist-info` exclusion is deferred.** *Why:* what the runtime reads must be measured
  first, and approval removes the pressure.
- **Q8. #2394 lands the graph driver id only and drops its pin.** *Why:* the pin can never run,
  and a pin beside approvals would let an older control plane ignore a revocation.
- **Q9. An approval stands until revoked**; the module rule is the only automatic stop. *Why:* an
  expiry would stop running releases without a person deciding it.
- **Q10. The canary runs at rollout only.** *Why:* it already runs before any vertical moves, and
  an approval makes nothing run.
- **Q11. Staff only** read a stored release.
- **Q12. Facts are fixed; a wrong fact needs new bytes.** *Why:* fixed facts let any approval row
  judge the release being left. Worst case, a `schema` approved too low lets a later move to a
  release that cannot read the data pass the no-lower guard, and only rolling forward repairs the
  scripts on it (§2.2). No mechanical check catches that case; the reviewer's reading of the
  migrations does. Correcting a fact before the first rollout was considered and not taken,
  because it would reopen the decided answer.
- **Q13. Fail closed (503), no caching.** *Why:* a cached approval could outlive its revocation.
- **Q14. "Not met" is recorded and does not refuse.** *Why:* refusing is stricter than D-63 and
  would block every driver until isolation exists.
- **Q15. No table of which release each script runs**; the revoke guard walks the settings under
  the hold, paged. *Why:* the settings are the record the ensurer trusts, and a second record needs
  a reconciliation and a backfill for a rare operation. Fixing facts at first approval (Q12) also
  removes any need for a run record.
- **Q16. A dependency built from another repository is third-party and must be listed.** *Why:*
  it is that project's code wherever it is installed; one from a public package index stays install
  output.
