---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/vertical-host': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/control-plane-api': minor
'create-substrat': patch
'@substrat-run/control-plane': patch
'@substrat-run/demo-callout': patch
'@substrat-run/demo-auth-server': patch
'@substrat-run/demo-manyfold': patch
'@substrat-run/demo-meridian': patch
'@substrat-run/demo-ticket0': patch
'@substrat-run/docs': patch
---

Host-side exports start moving out of the kernel (part of #1978). Every existing import keeps working: the kernel still exports each one for this release, as the same binding, and marks it `@deprecated` with its new home.

- **Header names** move to `@substrat-run/contracts`: `PLATFORM_SECRET_HEADER`, `PLATFORM_REQUEST_HEADER`, `EXPORTED_EVENTS_HEADER`, `CONNECTOR_ATTACHMENT_RECORD_HEADER`, `LIVE_MODE_HEADER` and the `LiveRefusal` type. They are importable from the package root and from a new `@substrat-run/contracts/wire-headers` subpath, which imports nothing.
- **`@substrat-run/vertical-host`** now exports `invocationLog`, `withInvocationLog`, `invocationStampOf`, `INVOCATION_RECORD_KEY`, `readRoutedNode`, `RouterAssertionError`, `assertPlatformCall`, `PlatformCallError`, `kickFlags`, `isUpgradeRequest` and their types. Import them from there.
- **`@substrat-run/adapter-cloudflare`** now exports the Analytics Engine connector-call recorder: `analyticsEngineConnectorCallRecorder`, `CONNECTOR_CALL_DATA_POINT_LAYOUT`, `connectorCallDataPoint` and `AnalyticsEngineDatasetLike`. The neutral recorder interface stays in the kernel.
- **`@substrat-run/control-plane-api`** now exports `isTerminalDispatchFailure`, `isTerminalProviderError`, `providerErrorStatus` and `RETRYABLE_CLIENT_STATUSES`.
- `invocationLevelOf` and `InvocationLevel` were already defined in `@substrat-run/contracts`. The kernel's copies of those exports are deprecated in favour of contracts.

The scaffold template and the demos now import from the new homes. Nothing a deployed vertical sends, reads or logs changes.
