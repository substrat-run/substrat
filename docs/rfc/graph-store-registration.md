---
status: proposed
layer: kernel
description: Graph class and catalog proposed for review; registration awaits a real D-63 release pin and isolation requirements.
---

# Graph store registration — pending D-63 review

PR #2301 originally registered graph under the unpinned-release proposal D-64.
The later ratification of [D-63](../decisions/D-063-a-store-kind-is-platform-code-registered-and-pinned-like-a-connector.md)
in #2306 explicitly rejected that proposal. This branch follows D-63 and retains
main's release upload, canary, rollout, rollback and schema checks unchanged.

Graph is **not registered**. `STORE_KINDS` stays empty and a hosted push declaring
`kind: 'graph'` is refused. This document preserves the proposed registration for
review; it does not authorize running a release.

## Proposed identity and catalog

The proposed kind id is `graph`, implemented in Python by class `Store` from the
ontomate workspace. The class and catalog still need review against an actual
source commit. Administration operations are excluded from the vertical catalog.
The platform's `RESERVED_STORE_OPERATIONS`, including `substrat.erase`, are required
separately.

```text
getSession
getScope
putScope
getContract
getSchemaOperations
getSchemaResourceByName
getSchemaResource
getSchemaNeighbourhood
getSchemaDeclarations
getSchemaSearch
getSchemaStatistics
postSchemaBatch
getSchemaChanges
postSchemaRevert
postSchemaCommit
getDataOperations
postDataBatch
getDataInstance
listDataInstances
searchDataInstances
getHistoryRevisions
getHistoryChanges
getHistoryTags
createHistoryTag
getResourceHistory
postFactHistory
resolveHistoryRevision
```

## Before enabling graph

- Review a real release bundle and its source commit. Record its computed sha256,
  full source commit and nonnegative schema version in the registration's
  `releases` list; do not substitute placeholder pins or an empty list.
- Review the exact class and operation catalog, the envelope, every reserved
  operation, and the absence of per-object state at module level. D-63's
  ratified text defers registering an external kind until stronger isolation
  exists; confirm that requirement is satisfied before enabling this one.
- Check that the release fits the current Python module rules: one `kind_`
  package, no vendored dependencies or reserved platform module names. The
  original proposal does not establish compatibility with these rules.
- Exercise the real dispatch upload and reserved-operation canary, and verify
  schema compatibility for rollout and rollback. Local entry tests alone do
  not establish a production dispatch upload.

Use the existing `substrat store-kind upload`, `rollout`, `rollback` and `status`
flow, with a human staff sign-in for writes. Uploading bytes can precede the pin;
running them requires the reviewed pin and a control-plane deployment containing
it. The former `store-kind publish --entry <file.py>` proposal is not the current
interface. See [the CLI implementation](../../packages/cli/src/store-kind.ts)
and [scope stores](../../apps/docs/concepts/scope-stores.md).
