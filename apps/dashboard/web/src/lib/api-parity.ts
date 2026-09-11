import type { AppFreshnessRow, AppScheduleRow as WireAppScheduleRow, FailureGroupRow as WireFailureGroupRow, ReleaseRow as WireReleaseRow, ReleasesView as WireReleasesView, ReleaseComparison as WireReleaseComparison, ReleaseSide as WireReleaseSide, TrafficSeries as WireTrafficSeries, FieldCoverageView as WireFieldCoverageView, AppHealthRow as WireAppHealthRow, EntityCoverage as WireEntityCoverage, FieldCoverageRow as WireFieldCoverageRow, TrafficBucket as WireTrafficBucket, ReleaseMarker as WireReleaseMarker, SweepRunView } from './api';
// Type-only reach into the worker: schedules.ts is environment-free (contracts types
// only), so it compiles under the DOM tsconfig, where the worker program could never
// swallow this file's DOM-typed sibling. Never imported at runtime — the two bundles
// stay separated by wire; only the COMPILER crosses.
import type {
  AppFreshnessRow as WorkerAppFreshnessRow,
  AppScheduleRow as WorkerAppScheduleRow,
  ScheduleRunView as WorkerRunView,
} from '../../../src/schedules';
import type { FailureGroupRow as WorkerFailureGroupRow } from '../../../src/failure-groups';
import type {
  FieldCoverageView as WorkerFieldCoverageView,
  EntityCoverage as WorkerEntityCoverage,
  FieldCoverageRow as WorkerFieldCoverageRow,
} from '../../../src/field-coverage';
import type { AppHealthRow as WorkerAppHealthRow } from '../../../src/fleet-health';
import type { ReleaseRow as WorkerReleaseRow, ReleasesView as WorkerReleasesView, ReleaseComparison as WorkerReleaseComparison, ReleaseSide as WorkerReleaseSide, TrafficSeries as WorkerTrafficSeries, TrafficBucket as WorkerTrafficBucket, ReleaseMarker as WorkerReleaseMarker } from '../../../src/releases';

/**
 * The web client hand-mirrors the worker's schedule row (this file's uniform
 * convention — every wire type in api.ts is a mirror). This is the compiler error
 * the mirror otherwise lacks: a field added on one side without the other fails the
 * web typecheck HERE, not as a silently misread panel.
 */
// Mutual assignability alone is not parity: `{ optional?: x }` and `{}` assign both
// ways, so an optional field added to one mirror would slip through — the precise
// drift this file exists to catch. The key-set comparison closes that hole for the
// top level; the second assertion below closes it for the nested run shape.
type Equal<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? [keyof A] extends [keyof B]
      ? [keyof B] extends [keyof A]
        ? true
        : false
      : false
    : false
  : false;

export const APP_SCHEDULE_ROW_PARITY: Equal<WireAppScheduleRow, WorkerAppScheduleRow> = true;
export const SCHEDULE_RUN_VIEW_PARITY: Equal<SweepRunView, WorkerRunView> = true;
export const APP_FRESHNESS_ROW_PARITY: Equal<AppFreshnessRow, WorkerAppFreshnessRow> = true;
export const FAILURE_GROUP_ROW_PARITY: Equal<WireFailureGroupRow, WorkerFailureGroupRow> = true;
export const RELEASE_ROW_PARITY: Equal<WireReleaseRow, WorkerReleaseRow> = true;
export const RELEASES_VIEW_PARITY: Equal<WireReleasesView, WorkerReleasesView> = true;
export const RELEASE_SIDE_PARITY: Equal<WireReleaseSide, WorkerReleaseSide> = true;
export const RELEASE_COMPARISON_PARITY: Equal<WireReleaseComparison, WorkerReleaseComparison> = true;
export const TRAFFIC_BUCKET_PARITY: Equal<WireTrafficBucket, WorkerTrafficBucket> = true;
export const RELEASE_MARKER_PARITY: Equal<WireReleaseMarker, WorkerReleaseMarker> = true;
export const TRAFFIC_SERIES_PARITY: Equal<WireTrafficSeries, WorkerTrafficSeries> = true;
export const FIELD_COVERAGE_ROW_PARITY: Equal<WireFieldCoverageRow, WorkerFieldCoverageRow> = true;
export const ENTITY_COVERAGE_PARITY: Equal<WireEntityCoverage, WorkerEntityCoverage> = true;
export const FIELD_COVERAGE_VIEW_PARITY: Equal<WireFieldCoverageView, WorkerFieldCoverageView> = true;
export const APP_HEALTH_ROW_PARITY: Equal<WireAppHealthRow, WorkerAppHealthRow> = true;
