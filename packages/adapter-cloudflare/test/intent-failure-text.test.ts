import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { platformActorId, platformRequestId, principalId, scopeId, tenantId, type PlatformRequest } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { drainScopePlatformRequests, MAX_PLATFORM_REQUEST_ATTEMPTS, type VerticalClient } from '@substrat-run/control-plane-api';
import { CloudflareScopeHost } from './test-host.js';
import { warmControlPlane } from './do-warmup.js';

beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

/**
 * #2554 on workerd, where the platform drain runs: its give-up and terminal rows, through the
 * directory DO. The scope's tenant's row says only what became of the intent, under the platform's
 * reference, and the handler's error (here naming another tenant, with an upstream trace handle) is
 * staff's row under the same one. The SQLite twin is `control-plane-api/test/intent-failure-text.test.ts`.
 */
describe('the drain files an intent failure as a pair (#2554)', () => {
  const staff = platformActorId.parse(ulid());
  const mine = tenantId.parse(ulid());
  const other = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const host = () => new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
  beforeAll(async () => {
    await host().admin.createTenant(staff, { id: mine, slug: `acme-${mine.toLowerCase()}`, name: 'Acme' });
    await host().admin.createTenant(staff, { id: other, slug: `tenant-a-${other.toLowerCase()}`, name: 'Tenant A' });
  });

  const intent = (kind: string, attempts: number): PlatformRequest => ({
    id: platformRequestId.parse(ulid()),
    kind,
    payload: {},
    requestedBy: principalId.parse(ulid()),
    impersonation: null,
    failure: null,
    status: 'pending',
    attempts,
    lastError: null,
    result: null,
    requestedAt: new Date().toISOString() as PlatformRequest['requestedAt'],
    settledAt: null,
  });

  it.each([
    ['terminal', 'failed', 0, (r: string) => `failed (reference ${r})`, (e: string) => `failed: ${e}`],
    [
      'attempt-ceiling',
      'pending',
      MAX_PLATFORM_REQUEST_ATTEMPTS - 1,
      (r: string) => `gave up after ${MAX_PLATFORM_REQUEST_ATTEMPTS} drain attempts (reference ${r})`,
      (e: string) => `gave up after ${MAX_PLATFORM_REQUEST_ATTEMPTS} drain attempts — last error: ${e}`,
    ],
  ] as const)('%s: the tenant reads what became of it; staff read the error by either id', async (stage, status, attempts, answered, said) => {
    const upstream = `cf${ulid().toLowerCase()}`;
    const error = `tenant ${other} scope ${scopeId.parse(ulid())}: something private; reference = ${upstream}`;
    // A kind of its own per case, so each case reads only its own row.
    const kind = `peer-invoke-${stage}`;
    const request = intent(kind, attempts);
    const client = {
      listPlatformRequests: async () => [request],
      settlePlatformRequest: async () => undefined,
    } as unknown as Pick<VerticalClient, 'listPlatformRequests' | 'settlePlatformRequest'>;
    const writes: Promise<void>[] = [];
    await drainScopePlatformRequests(
      client,
      { tenantId: mine, scopeId: s, vertical: 'demo-vert', scope: { kind: 'app', forkedFrom: null }, lifecycle: { scope: 'active', tenant: 'active' } },
      { [kind]: async () => ({ status, error }) },
      { recordFailure: (entry) => void writes.push(host().admin.recordOpsFailure({ actor: staff, ...entry })) },
    );
    await Promise.all(writes);

    const rows = await host().admin.listOpsFailures(staff, { tenantId: mine, operation: `intent.${kind}` });
    expect(rows.map((r) => r.stage)).toEqual([stage]);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.reference).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(row.message).toBe(`platform intent ${request.id} ${answered(row.reference!)}`);
    for (const text of [other, 'something private', upstream]) expect(JSON.stringify(row)).not.toContain(text);
    expect(await host().admin.listOpsFailures(staff, { tenantId: other })).toEqual([]);
    expect(await host().admin.listOpsFailures(staff, { tenantId: mine, reference: upstream })).toEqual([]);

    for (const reference of [row.reference!, upstream]) {
      const pair = await host().admin.listOpsFailures(staff, { reference, referenceInText: true });
      expect(pair.map((f) => [f.tenantId, f.scopeId, f.reference])).toEqual([
        [mine, s, row.reference],
        [null, s, row.reference],
      ]);
      expect(pair[1]!.message).toBe(`[upstream reference = ${upstream}] platform intent ${request.id} ${said(error)}`);
    }
  });
});
