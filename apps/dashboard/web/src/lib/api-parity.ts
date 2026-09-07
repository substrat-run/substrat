import type { AppScheduleRow as WireAppScheduleRow, SweepRunView } from './api';
// Type-only reach into the worker: schedules.ts is environment-free (contracts types
// only), so it compiles under the DOM tsconfig, where the worker program could never
// swallow this file's DOM-typed sibling. Never imported at runtime — the two bundles
// stay separated by wire; only the COMPILER crosses.
import type { AppScheduleRow as WorkerAppScheduleRow, ScheduleRunView as WorkerRunView } from '../../../src/schedules';

/**
 * The web client hand-mirrors the worker's schedule row (this file's uniform
 * convention — every wire type in api.ts is a mirror). This is the compiler error
 * the mirror otherwise lacks: a field added on one side without the other fails the
 * web typecheck HERE, not as a silently misread panel.
 */
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

export const APP_SCHEDULE_ROW_PARITY: Equal<WireAppScheduleRow, WorkerAppScheduleRow> = true;
export const SCHEDULE_RUN_VIEW_PARITY: Equal<SweepRunView, WorkerRunView> = true;
