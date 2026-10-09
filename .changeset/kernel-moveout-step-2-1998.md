---
'@substrat-run/kernel': minor
'@substrat-run/vertical-host': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/router': patch
'@substrat-run/docs': patch
---

**Breaking:** the kernel no longer exports the host-side code it deprecated in 0.136.0 (part of #1978). The code now lives in its new homes. If you still import one of these names from `@substrat-run/kernel`, import it from the package below; it is the same function.

- **`@substrat-run/vertical-host`**: `invocationLog`, `withInvocationLog`, `invocationStampOf`, `fieldCoverageArmed`, `INVOCATION_RECORD_KEY`, `readRoutedNode`, `RouterAssertionError`, and the types `InvocationLogContext`, `InvocationRecord`, `InvocationStamp`, `ModuleWorker`, `IncomingRequest`, `RoutedNode`, `HeaderReader` and `ReadRoutedNodeOptions`.
- **`@substrat-run/adapter-cloudflare`**: `analyticsEngineConnectorCallRecorder`, `CONNECTOR_CALL_DATA_POINT_LAYOUT`, `connectorCallDataPoint` and `AnalyticsEngineDatasetLike`.
- **`@substrat-run/control-plane-api`**: `isTerminalDispatchFailure`, `isTerminalProviderError`, `providerErrorStatus` and `RETRYABLE_CLIENT_STATUSES`.
- **`@substrat-run/contracts`**: `invocationLevelOf`, `InvocationLevel`, `LIVE_MODE_HEADER`, `LiveRefusal`, `PLATFORM_SECRET_HEADER`, `PLATFORM_REQUEST_HEADER`, `EXPORTED_EVENTS_HEADER` and `CONNECTOR_ATTACHMENT_RECORD_HEADER`.

Two deprecations are withdrawn, and these names stay in the kernel:

- **The invocation line's shape** (`InvocationLogLine`, `OutputFieldsReport`) stays, beside `invocationLine`, because the scope host writes the consumer and schedule lines with it. `@substrat-run/vertical-host` still re-exports both types. The kernel also gains three subpaths that import nothing at run time, for code bundled in front of every vertical: `@substrat-run/kernel/invocation-line`, `@substrat-run/kernel/ulid` and `@substrat-run/kernel/secret-match` (`secretMatches`, the constant-time compare).
- **`isUpgradeRequest`** stays beside the `LiveReadSurface` contract, because the hosted adapter's live-read door uses it too. `@substrat-run/vertical-host` still re-exports it.

`assertPlatformCall`, `PlatformCallError` and `kickFlags` remain deprecated kernel exports for now. Import them from `@substrat-run/vertical-host`.

Nothing a deployed vertical sends, reads or logs changes. The entry module the platform uploads in front of every vertical is now built from `@substrat-run/vertical-host`, and its code is the same.
