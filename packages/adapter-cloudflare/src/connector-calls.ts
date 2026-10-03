/**
 * The hosted connector-call recorder: one Analytics Engine point per call (#1691, #1978).
 *
 * Moving here from the kernel, which keeps the neutral half — the record, the
 * `ConnectorCallRecorder` interface and the no-op self-host default. For one release the
 * definition still lives in `@substrat-run/kernel` and this module re-exports that same
 * binding, so an import from either package is the one function. Import it from here.
 */
export {
  analyticsEngineConnectorCallRecorder,
  CONNECTOR_CALL_DATA_POINT_LAYOUT,
  connectorCallDataPoint,
} from '@substrat-run/kernel';
export type { AnalyticsEngineDatasetLike } from '@substrat-run/kernel';
