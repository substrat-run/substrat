---
status: proposed
layer: kernel
description: The graph driver is registered with its first pinned release. Whether D-63's isolation sentence allows that is open for the reviewer.
---

# Graph store registration

PR #2301 originally registered graph under the unpinned-release proposal D-64.
The later ratification of [D-63](../decisions/D-063-a-store-kind-is-platform-code-registered-and-pinned-like-a-connector.md)
in #2306 explicitly rejected that proposal. The registration that landed follows D-63:
one pinned release in `STORE_DRIVERS`, class `Store`, every reserved operation, and
the catalog below. A hosted push that declares `driver: 'graph'` is no longer refused
for an unregistered driver. Running the release still needs its bytes uploaded and a
control-plane deploy that contains the pin. Neither is done here.

D-63 also says no driver written outside this repo is registered until a driver cannot
affect data outside the object it serves. That sentence and this registration are in
conflict. The registration is here for review; it does not claim the isolation exists.

## Identity and catalog

The driver id is `graph`, implemented in Python by class `Store`. The class and
catalog are what the registration pins. Administration operations are excluded from
the vertical catalog.
The platform's `RESERVED_STORE_OPERATIONS`, including `substrat.erase`, are required
separately.

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

## Before the release runs

- The pin is the registration in `packages/contracts/src/deploy.ts`. Review the
  packed release against it. The schema is 0.
- Review the class and the catalog, the envelope, and every reserved operation.
  D-63 defers registering a driver written outside this repo until a driver
  cannot affect data outside the object it serves. That requirement is not
  claimed to be met.
- The release is one `driver_` package plus `python_modules/<path>` for its
  dependencies. It does not ship `workers`, `js`, `pyodide` or the workers
  runtime SDK. Three files the current rule still allows are in the pin:
  `python_modules/asgi.py`, `python_modules/_cloudflare_compat_flags.pyi` and
  `python_modules/_pyodide_entrypoint_helper.pyi`. Whether those should be
  refused is open.
- A dispatch upload, the reserved-operation canary, and a rollout have not
  been run. Local packing does not establish that a production upload of this
  size succeeds.

Use the existing `substrat store-driver upload`, `rollout`, `rollback` and `status`
flow, with a human staff sign-in for writes. Uploading bytes can precede the pin;
running them requires the reviewed pin and a control-plane deployment containing
it. The former `store-driver publish --entry <file.py>` proposal is not the current
interface. See [the CLI implementation](../../packages/cli/src/store-driver.ts)
and [scope stores](../../apps/docs/concepts/scope-stores.md).
