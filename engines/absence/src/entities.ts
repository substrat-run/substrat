import { defineEntities } from '@substrat-run/contracts';
import { z } from 'zod';

/**
 * engine-absence' entity (#697/#707).
 *
 * The leave TYPE is what the platform points at — `absence-leave-type` is the
 * only entity type this engine names in an `EntityRef`. The ledger and the
 * requests are rows it owns: an accrual is not something a grant narrows to.
 *
 * Row versus published, a third time (workorder: two columns → one `EntityRef`;
 * invites: a hash that must not be published; here: SQLite has no boolean, so
 * the row stores `active` as 0/1 and `LeaveType` publishes it as a boolean, in
 * camelCase). The registry describes what is STORED — that is what the journal
 * comparison checks against.
 */
export const absenceEntities = defineEntities({
  'leave-type': {
    table: 'absence_leave_types',
    fields: z.object({
      key: z.string(),
      floor: z.string(),
      /** 0/1 — SQLite has no boolean. `LeaveType.active` publishes it as one. */
      active: z.number(),
      created_at: z.string(),
    }),
    key: ['key'],
  },
});

/** The stored row. `LeaveType` is the published projection of it. */
export const leaveTypeRow = absenceEntities['leave-type'].fields;
