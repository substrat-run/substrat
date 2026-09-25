import { useEffect, useState } from 'react';
import { api, ApiError, type TenantMetricsRow } from './api';
import { DEV_MOCK, MOCK_TENANT_METRICS } from './mock';

export type MetricsState = { state: 'loading' } | { state: 'error' } | { state: 'absent' } | { state: 'ok'; rows: TenantMetricsRow[] };

/**
 * One read of an app's own last 24 hours per surface, for every surface on the Overview
 * that draws from it: the Errors tile and the traffic card's surface table share it
 * rather than each asking (#1783 review). A zoomed traffic window is a different read
 * and stays the card's own. Cleared on a scope change.
 */
export function useTenantMetrics(scopeId: string): MetricsState {
  const [metrics, setMetrics] = useState<MetricsState>({ state: 'loading' });
  useEffect(() => {
    if (DEV_MOCK) {
      setMetrics({ state: 'ok', rows: MOCK_TENANT_METRICS });
      return;
    }
    let live = true;
    setMetrics({ state: 'loading' });
    api
      .appTenantMetrics(scopeId, 24)
      .then((rows) => live && setMetrics({ state: 'ok', rows }))
      // 501 = this plane counts no traffic, which is a different fact from "no traffic".
      .catch((e) => live && setMetrics({ state: e instanceof ApiError && e.status === 501 ? 'absent' : 'error' }));
    return () => {
      live = false;
    };
  }, [scopeId]);
  return metrics;
}
