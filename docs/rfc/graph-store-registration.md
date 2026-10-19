---
status: proposed
layer: kernel
description: The graph driver is not registered yet. It is written outside this repo, so its id is registered at step 5 of the release-approval RFC, once a decision record lifts D-63's isolation sentence for it. No release is pinned in source.
---

# Graph store registration

`graph` is a store driver written outside this repo. It is **not registered**:
`STORE_DRIVERS` stays empty, and a hosted push that declares `driver: 'graph'` is
refused with "declares driver 'graph', which is not registered".

PR #2301 first registered graph under the unpinned-release proposal D-64, which the
ratification of [D-63](../decisions/D-063-a-store-kind-is-platform-code-registered-and-pinned-like-a-connector.md)
in #2306 rejected. #2394 then proposed a D-63 pin of one release. That pin is
dropped: [store driver releases are uploaded and approved](./store-driver-release-approval.md)
(Q8) decided that #2394 lands the graph driver id only, without a pin, because
releases become uploads a person approves in the control plane, and a pin beside
approvals would let an older control plane ignore a revocation.

## When graph is registered

[The approval RFC's §5](./store-driver-release-approval.md#5-2394-and-the-rollout-order)
sets the order. The graph driver's id and its isolation basis are registered at
step 5, after:

1. the decision record amending D-63 (§7 of that RFC);
2. the approval vocabulary and directory tables;
3. the approve, revoke and status routes, the CLI, and the isolation basis field;
4. the switch, which moves every reader to approvals and removes `releases` and
   `className` from `storeDriverRegistration`. Before it, an id-only registration
   does not parse.

Graph is third-party (Q5), so its registration also waits for a decision record
that lifts D-63's isolation sentence for it. Nothing here claims that a driver
cannot affect data outside the object it serves. Until that record exists, the
graph driver is not registered and no release of it is approved.

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

## What lands now

What #2394 keeps holds with no driver registered, and is what the registration
will need:

- The push check, the sandbox contract and both uploads' plans judge a vertical's
  scope stores against the registry the control plane is configured with
  (`storeDrivers`), which is `STORE_DRIVERS` on a hosted control plane.
- Once a driver is registered, a scope whose running version cannot be named or read
  refuses with 503 only where some version of its vertical has declared a store. A
  store exists only under a binding a version declared, so a vertical that never
  declared one proceeds as before stores. See [scope stores](./scope-stores.md).

Release bytes go up with `substrat store-driver upload` and are run with `rollout`,
`rollback` and `status`, with a human staff sign-in for writes. See
[the CLI implementation](../../packages/cli/src/store-driver.ts) and
[scope stores](../../apps/docs/concepts/scope-stores.md).
