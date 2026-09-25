import type { AppSchedulesView, SweepRunView } from './api';
import { MOCK_APP_SCHEDULES } from './mock';

/**
 * The schedules preview (#1767): the shared fixture plus one fast schedule. Every
 * fifteen minutes fills the read's twenty-run cap inside five hours, so the preview shows
 * what a truncated record looks like on a 24h axis — counts marked as lower bounds and the
 * unread stretch shaded — instead of only schedules too slow ever to reach it.
 */
const fast: SweepRunView[] = Array.from({ length: 20 }, (_, i) => ({
  id: `01MOCKSCHEDC${String(19 - i).padStart(14, '0')}`,
  outcome: i === 3 || i === 4 ? 'failed' : 'ok',
  at: new Date(Date.now() - (6 + i * 15) * 60e3).toISOString(),
  error: i === 3 || i === 4 ? 'connector timed out after 30s' : null,
  elapsedMs: 120 + i,
  observedAt: null,
}));

export const MOCK_SCHEDULES_VIEW: AppSchedulesView = {
  ...MOCK_APP_SCHEDULES,
  schedules: [
    {
      operation: 'helpdesk/sync-mailbox',
      moduleId: '@substrat-run/demo-helpdesk',
      everyMinutes: 15,
      permissions: ['helpdesk:ticket-write'],
      lastRun: fast[0]!,
      runs: fast,
      nextDueAt: new Date(Date.parse(fast[0]!.at) + 15 * 60e3).toISOString(),
      health: 'healthy',
    },
    ...(MOCK_APP_SCHEDULES.schedules ?? []),
  ],
};
