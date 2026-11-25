// K-70: the directory's outbox to the lake, in the ControlPlaneDO, where the hosted directory lives:
// its triggers, its AUTOINCREMENT and its column read are workerd's SQLite, not node's.
import { env } from 'cloudflare:test';
import { beforeAll } from 'vitest';
import { directoryLakeContractSuite } from '@substrat-run/contract-tests';
import { warmControlPlane } from './do-warmup.js';
import { CloudflareScopeHost } from './test-host.js';

beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

directoryLakeContractSuite('adapter-cloudflare', async () => {
  const host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
  return { host, cleanup: async () => host.close() };
});
