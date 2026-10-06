---
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
---

An executor handler can now attribute its writes to a person from the `admin` it is handed (#2069). `HostAdmin.attributed(onBehalfOf)` returns the same admin with `onBehalfOf` added, and it keeps everything that admin already carries. For a handler's `admin`, that includes its event. Rows written through it name the person and the `causedBy` event, so the K-22 join between a scope's half of the audit trail and the directory's holds without the handler passing the event again. A view of a view keeps the inner view's cause. Both adapters implement it.

The membership executor now attributes this way and no longer makes a view of the host. Before this change, an executor that attributed through `host.attributed(onBehalfOf)` had to repeat `{ causedBy: event.id }`, and if it left that out, its rows were written with a NULL `causedBy` and nothing failed.

The `{ causedBy }` option on `ScopeHost.attributed`, added in #2055, is now deprecated. It still works, and the membership executor uses it as a fallback on a host whose handed admin has no `attributed` (an adapter at 0.139), so rows written there still name both the person and the event. `ScopeHost.attributed(onBehalfOf)` without it is unchanged and not deprecated.

`@substrat-run/contract-tests`: `causedByContractSuite` now covers attributing from a handed admin through every door (executor, in-process connector, routed `dispatchConnector`), a view of a view, and the host's own admin attributed with no cause. `membershipExecutorContractSuite`'s interceptor now wraps the admin handed to each executor (through `registerExecutor`) instead of `host.attributed`.
