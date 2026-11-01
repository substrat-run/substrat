---
status: building
layer: kernel
description: The graph driver is registered by its id, on D-67, the decision record that lifts D-63's isolation sentence for it. No release of it is approved yet, so no store script runs and a hosted push that declares it is refused before anything is uploaded.
---

# Graph store registration

`graph` is a store driver written outside this repo. It is **registered** in
`STORE_DRIVERS` by its id and its isolation basis, and nothing about a release:

```ts
{ driver: 'graph', isolationBasis: { kind: 'decisionRecord', decisionRecord: 'D-67' } }
```

This is step 5 of [store driver releases are uploaded and approved](./store-driver-release-approval.md#5-2394-and-the-rollout-order).
Steps 2 to 4 (the approval vocabulary and tables, the approve, revoke and status routes
with the isolation basis, and the switch of every reader to approvals) came before it.
#2394 dropped the D-63 pin it first proposed and prepared the registration; this change
makes it.

## The isolation basis

Graph is third-party (Q5), so it is registered on
[D-67](../decisions/D-067-the-graph-driver-is-admitted-under-a-reviewed-release-isolation-lift.md),
which lifts D-63's isolation sentence for it and is admitted in
`STORE_DRIVER_ADMITTED_ISOLATION_LIFTS`. D-67 does not claim that the driver cannot affect
data outside the object it serves. It accepts that the tenants of one vertical share the
driver's script, kept apart by the driver's per-object design and by the review of each
release, and it limits the first use to synthetic data until the driver's `substrat.erase`
erases. That first use is an operating rule the approver and operators keep, not a check in
code. Under a decision-record basis an approval may name any repository; the review judges
the list.

## What registration changes, and what it does not

- The push check and the control plane admit a declaration of `driver: 'graph'`.
- A store script runs only a release a person has approved and nobody has revoked. With no
  approval, a push or serve that declares graph is refused before anything is uploaded
  (409 with no release rolled out, 422 for a release with no live approval), and no
  version is published, so no scope can come to hold a store.
- `mayHoldScopeStores` arms backup, wipe and erasure: a scope whose running version cannot
  be named or read refuses with 503 where some version of its vertical declared a store.
  A vertical that never declared one proceeds as before. See [scope stores](./scope-stores.md).
- The scheduled rebuild walks graph's scripts. It rebuilds only scripts that exist, so it
  creates none.
- A raw version publish (`POST /verticals/:slug/versions`) that declares graph puts the
  store scripts in place first, as a push does, and refuses the same way.

## Rollout of this change

- **The first-rollout attestation gate is deferred.** The approval RFC's step 5 refuses the
  first rollout after the registering deploy until a person attests that the deploy has
  finished. It is not built. During the deploy's overlap an older control plane, whose
  registry is empty, answers 403 "is not registered" to graph's routes and pushes, and its
  `mayHoldScopeStores` answers that no scope holds a store, so its backup, wipe and erasure
  skip stores. The first approval and rollout of a graph release therefore wait until the
  control-plane deploy has finished everywhere.
- **The rollback floor.** Once a graph store holds data, the control plane is never rolled
  back below the release that registered graph, for the same reason: below it, backup, wipe
  and erasure skip stores that do hold data.

## What the first approval will record

The class and the operation catalog are facts about one release, so they move to
the approval (Q2), not to the registration. For the release reviewed so far they
are class `Store` and the catalog below. Administration operations are excluded
from the vertical catalog. The platform's `RESERVED_STORE_OPERATIONS`, including
`substrat.erase`, are required separately: the canary asserts each of them on the
bytes at every rollout.

```text
createHistoryTag
getDataInstance
getDataOperations
getHistoryChanges
getHistoryRevisions
getHistoryTags
getPackageInstallationList
getPackagePartFile
getResourceHistory
getSchemaChanges
getSchemaDeclarations
getSchemaNeighbourhood
getSchemaOperations
getSchemaResource
getSchemaResourceByName
getSchemaSearch
getSchemaStatistics
getScope
getSession
graphqlData
graphqlSchema
graphqlScope
listDataInstances
postDataBatch
postFactHistory
postPackageExport
postPackageExportPlan
postPackageInstallation
postSchemaBatch
postSchemaCommit
postSchemaRevert
putPackageUpload
putScope
resolveHistoryRevision
searchDataInstances
```

The approval also records the source references the approver read (Q6): the
driver package and every dependency built from a repository (Q16).

Release bytes go up with `substrat store-driver upload`, are approved with `approve`, and
are run with `rollout`, `rollback` and `status`, with a human staff sign-in for writes. See
[the CLI implementation](../../packages/cli/src/store-driver.ts) and
[scope stores](../../apps/docs/concepts/scope-stores.md).
