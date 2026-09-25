import { useEffect, useState } from 'react';
import { api, type AppSchedulesView } from './api';
import { DEV_MOCK } from './mock';
import { MOCK_SCHEDULES_VIEW } from './mock-schedules';

export type SchedulesState = { state: 'loading' } | { state: 'error' } | { state: 'ok'; view: AppSchedulesView };

/**
 * One read of an app's schedules and freshness, for every surface on the page that draws
 * from it. The route fans out to the scope's schedule and freshness state, so the Overview's
 * Health tile and its Schedules card share this instead of each asking (#1777 review).
 * Cleared on a scope change: keeping the previous app's rows visible while the next app's
 * request is in flight would caption one app with another's schedules.
 */
export function useAppSchedules(scopeId: string): SchedulesState {
  const [schedules, setSchedules] = useState<SchedulesState>({ state: 'loading' });
  useEffect(() => {
    if (DEV_MOCK) {
      setSchedules({ state: 'ok', view: MOCK_SCHEDULES_VIEW });
      return;
    }
    let live = true;
    setSchedules({ state: 'loading' });
    api
      .appSchedules(scopeId)
      .then((v) => live && setSchedules({ state: 'ok', view: v }))
      .catch(() => live && setSchedules({ state: 'error' }));
    return () => {
      live = false;
    };
  }, [scopeId]);
  return schedules;
}
