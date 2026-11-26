// K-73: the platform's bookkeeping reads, one access-log row per pass, written to the ControlPlaneDO.
import { env } from 'cloudflare:test';
import { beforeAll } from 'vitest';
import { accessSummaryContractSuite } from '@substrat-run/contract-tests';
import { warmControlPlane } from './do-warmup.js';
import { CloudflareScopeHost } from './test-host.js';

beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

accessSummaryContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
  return { host, cleanup: async () => host.close() };
});
