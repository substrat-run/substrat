import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, scopeId, tenantId, type ModelUsageEntry, type ModelUsageLine } from '@substrat-run/contracts';
import { ulid, type FetchLike } from '@substrat-run/kernel';
import {
  createCfModelCostReader,
  createControlPlaneApi,
  DEV_ACTOR_HEADER,
  MODEL_RECONCILE_OPERATION,
  reconcileModelDay,
  runModelReconciliationPass,
  UNSAFE_devPlatformActorAuth,
  type ModelCostDay,
  type ModelCostReader,
} from '../src/index.js';

const tenant = tenantId.parse(ulid());
const reported = scopeId.parse(ulid());
const silent = scopeId.parse(ulid());

const line = (scope: string, over: Partial<ModelUsageLine> = {}): ModelUsageLine => ({
  attribution: { tenant, scope: scope as ModelUsageLine['attribution']['scope'], vertical: 'desk', version: '1', operation: 'desk/answer' },
  model: 'cloudflare:@cf/zai-org/glm-5.2',
  provider: 'cloudflare',
  modelId: '@cf/zai-org/glm-5.2',
  reported: true,
  inputTokens: 1000,
  outputTokens: 200,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  listUsd: '0.5',
  at: '2026-11-19T10:00:00.000Z',
  elapsedMs: 900,
  ...over,
});
const entry = (l: ModelUsageLine): ModelUsageEntry => ({ ...l, id: ulid(), requestId: ulid() });
const gw = (over: Partial<ModelCostDay['gateway'][number]>): ModelCostDay['gateway'][number] => ({
  tenant, scope: reported, vertical: '@acme/desk', provider: 'workers-ai', modelId: '@cf/zai-org/glm-5.2',
  calls: 1, inputTokens: 1000, outputTokens: 200, costUsd: '0.5', ...over,
});

describe('reconcileModelDay', () => {
  it('sorts each (tenant, scope, model) into one status, and keeps what nothing attributes beside them', () => {
    const day = reconcileModelDay({
      day: '2026-11-19',
      readAt: '2026-11-20T03:00:00.000Z',
      gatewayProviders: ['cloudflare'],
      ledger: [
        // matched: two runs, three gateway requests (a tool step) at a cost within tolerance
        entry(line(reported)), entry(line(reported)),
        // discrepancy on both counts: two lines, one request, and a cost 4× the list price
        entry(line(reported, { modelId: '@cf/a', model: 'cloudflare:@cf/a' })), entry(line(reported, { modelId: '@cf/a', model: 'cloudflare:@cf/a' })),
        // ledger-only: the binding ran it, so no gateway saw it
        entry(line(reported, { modelId: '@cf/binding', model: 'cloudflare:@cf/binding' })),
        // an unpriced line is never judged on cost
        entry(line(reported, { modelId: '@cf/unpriced', model: 'cloudflare:@cf/unpriced', listUsd: null })),
        // a provider that never passes the gateway
        entry(line(reported, { provider: 'anthropic', modelId: 'claude-opus-5', model: 'anthropic:claude-opus-5' })),
      ],
      cost: {
        gateway: [
          gw({ calls: 3, costUsd: '1.05' }),
          gw({ modelId: '@cf/a', calls: 1, costUsd: '4' }),
          gw({ modelId: '@cf/unpriced', calls: 1, costUsd: '9' }),
          // gateway-only: the self-report gap
          gw({ scope: silent, calls: 4, costUsd: '0.25' }),
          // no metadata: a caller outside the platform's model hosts
          gw({ tenant: null, scope: null, vertical: null, calls: 2, costUsd: '0.1' }),
          // every request errored: no call on either side
          gw({ scope: silent, modelId: '@cf/errored', calls: 0, costUsd: '0' }),
        ],
        workersAi: [
          { modelId: '@cf/zai-org/glm-5.2', requestSource: 'aig binding', calls: 9, neurons: '5000' },
          { modelId: '@cf/meta/llama', requestSource: 'unknown', calls: 7, neurons: '100000' },
        ],
      },
    });
    const by = Object.fromEntries(day.rows.map((r) => [`${r.scopeId === silent ? 'silent' : 'reported'} ${r.modelId}`, r]));
    expect(Object.keys(by).sort()).toEqual([
      'reported @cf/a', 'reported @cf/binding', 'reported @cf/unpriced', 'reported @cf/zai-org/glm-5.2', 'silent @cf/zai-org/glm-5.2',
    ]);
    expect(by['reported @cf/zai-org/glm-5.2']).toMatchObject({ status: 'matched', differs: [], vertical: 'desk', deltaUsd: '0.05' });
    expect(by['reported @cf/a']).toMatchObject({ status: 'discrepancy', differs: ['calls', 'cost'] });
    expect(by['reported @cf/binding']).toMatchObject({ status: 'ledger-only', gateway: { calls: 0 } });
    expect(by['reported @cf/unpriced']).toMatchObject({ status: 'matched', ledger: { unpriced: 1, listUsd: '0' } });
    // the ledger has no vertical for it, so the gateway's package name stands in
    expect(by['silent @cf/zai-org/glm-5.2']).toMatchObject({ status: 'gateway-only', vertical: '@acme/desk', ledger: { calls: 0 }, gateway: { calls: 4 } });
    expect(day.unattributedGateway).toEqual([{ provider: 'workers-ai', modelId: '@cf/zai-org/glm-5.2', calls: 2, costUsd: '0.1' }]);
    expect(day.workersAiWithoutGateway).toEqual([{ modelId: '@cf/meta/llama', requestSource: 'unknown', calls: 7, neurons: '100000', estimatedUsd: '1.1' }]);
    expect(day.offGatewayLedgerCalls).toBe(1);
    expect(day.totals).toEqual({ ledgerListUsd: '2.5', gatewayCostUsd: '14.4', workersAiWithoutGatewayUsd: '1.1' });
  });
});

describe('createCfModelCostReader', () => {
  const answer = (body: unknown, status = 200): FetchLike => async () =>
    ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), arrayBuffer: async () => new ArrayBuffer(0) }) as never;

  it('reads one UTC day: successful requests only, empty metadata as none, floats as 6-dp decimals', async () => {
    const seen: string[] = [];
    const fetch: FetchLike = async (url, init) => {
      seen.push(url, String(init?.body));
      return answer({
        data: { viewer: { accounts: [{
          gateway: [{ count: 5, sum: { cost: 0.34272264513, tokensIn: 10, tokensOut: 2, erroredRequests: 1 }, dimensions: { provider: 'workers-ai', model: '@cf/m', tenant: 't', scope: 's', vertical: '' } }],
          workersAi: [{ count: 3, sum: { totalNeurons: 1855.21198 }, dimensions: { modelId: '@cf/m', requestSource: 'unknown' } }],
        }] } },
      })(url, init);
    };
    const day = await createCfModelCostReader({ accountId: 'acct', apiToken: 'tok', fetch }).readDay('2026-11-19');
    expect(JSON.parse(seen[1]!).variables).toEqual({ accountTag: 'acct', start: '2026-11-19T00:00:00.000Z', end: '2026-11-20T00:00:00.000Z' });
    expect(day).toEqual({
      gateway: [{ tenant: 't', scope: 's', vertical: null, provider: 'workers-ai', modelId: '@cf/m', calls: 4, inputTokens: 10, outputTokens: 2, costUsd: '0.342723' }],
      workersAi: [{ modelId: '@cf/m', requestSource: 'unknown', calls: 3, neurons: '1855.21198' }],
    });
  });

  it('refuses an answer it cannot read whole', async () => {
    const reader = (body: unknown, status?: number) => createCfModelCostReader({ accountId: 'a', apiToken: 't', fetch: answer(body, status) });
    await expect(reader({}, 403).readDay('2026-11-19')).rejects.toThrow(/403/);
    await expect(reader({ errors: [{ message: 'no access' }] }).readDay('2026-11-19')).rejects.toThrow(/no access/);
    const full = Array.from({ length: 10_000 }, () => ({ count: 1, sum: { totalNeurons: 1 }, dimensions: { modelId: 'm', requestSource: 'unknown' } }));
    await expect(reader({ data: { viewer: { accounts: [{ gateway: [], workersAi: full }] } } }).readDay('2026-11-19')).rejects.toThrow(/refuses part of a day/);
  });
});

describe('the scheduled pass and the staff read', () => {
  const actor = platformActorId.parse(ulid());
  // Two days before the real today, so the route (which reads the real clock) counts it closed.
  const day = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
  const at = `${day}T12:00:00.000Z`;
  const reader: ModelCostReader = {
    readDay: async (d) =>
      d === day
        ? {
            gateway: [
              gw({ scope: silent, calls: 2, costUsd: '0.2' }),
              gw({ calls: 1, costUsd: '0.5' }),
              // another environment's tenant, in the same account's analytics: never this directory's gap
              gw({ tenant: ulid(), scope: silent, calls: 5, costUsd: '3' }),
            ],
            workersAi: [{ modelId: '@cf/x', requestSource: 'unknown', calls: 1, neurons: '1000' }],
          }
        : { gateway: [], workersAi: [] },
  };
  let dir: string;
  let host: SqliteScopeHost;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-model-reconcile-'));
    host = new SqliteScopeHost({ dir });
    await host.admin.createTenant(actor, { id: tenant, slug: 'acme', name: 'Acme' });
    await host.admin.recordModelUsage({ requestId: ulid(), line: line(reported, { at }) });
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('files each closed day once, with no tenant on the rows, and a staff read shows the whole day', async () => {
    const deps = {
      admin: host.admin,
      actor,
      reader,
      gatewayProviders: ['cloudflare'],
      now: () => new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000 + 3 * 3_600_000),
      lookbackDays: 1,
    };
    const first = await runModelReconciliationPass(deps);
    expect(first).toEqual({
      reconciled: [{ day, matched: 1, discrepancy: 0, ledgerOnly: 0, gatewayOnly: 1, workersAiWithoutGatewayUsd: '0.011' }],
      failed: [],
    });
    const filed = await host.admin.listOpsFailures(actor, { operation: MODEL_RECONCILE_OPERATION });
    expect(filed.map((f) => [f.stage, f.scopeId, f.tenantId]).sort()).toEqual([
      ['gateway-only', silent, null],
      ['without-gateway', null, null],
    ]);
    expect(await runModelReconciliationPass(deps)).toEqual({ reconciled: [], failed: [] });
    expect(await host.admin.listOpsFailures(actor, { operation: MODEL_RECONCILE_OPERATION })).toHaveLength(2);

    const app = createControlPlaneApi({ host, authenticate: UNSAFE_devPlatformActorAuth(), modelReconciliation: { reader, gatewayProviders: ['cloudflare'] } });
    const res = await app.request(`/model-usage/reconciliation?since=${day}&until=${day}`, { headers: { [DEV_ACTOR_HEADER]: actor } });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json();
    expect(body.days.map((d: { day: string; rows: { status: string }[] }) => [d.day, d.rows.map((r) => r.status).sort()])).toEqual([[day, ['gateway-only', 'matched']]]);
    expect(body.days[0].otherDirectoryGateway).toEqual({ calls: 5, costUsd: '3' });
    const today = new Date().toISOString().slice(0, 10);
    expect((await app.request(`/model-usage/reconciliation?until=${today}`, { headers: { [DEV_ACTOR_HEADER]: actor } })).status).toBe(400);
  });
});
