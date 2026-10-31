/**
 * A runner for a scope-store process already listening on loopback, such as the graph driver's
 * local process: `GET /health`, and one envelope per `POST /objects/<object name>`.
 *
 * The process owns its objects and outlives the runner, so `stop` leaves it running.
 */
import { scopeStoreObjectName, storeResponse } from '@substrat-run/contracts';
import type { ScopeStoreRunner } from '@substrat-run/kernel';

export function loopbackRunner(driver: string, baseUrl: string): ScopeStoreRunner {
  const base = baseUrl.replace(/\/$/, '');
  return {
    driver,
    async start() {
      const health = await fetch(`${base}/health`);
      if (!health.ok) throw new Error(`the scope-store process at ${base} answered ${health.status} to /health`);
    },
    async stop() {},
    async invoke(address, request) {
      const name = scopeStoreObjectName(address.tenantId, address.vertical, address.scopeId, address.binding);
      const path = name.split('/').map(encodeURIComponent).join('/');
      const response = await fetch(`${base}/objects/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
      return storeResponse.parse(await response.json());
    },
  };
}
