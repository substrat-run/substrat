import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import {
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  platformRequestId,
  type PlatformRequest,
  type EntitlementGrant,
} from '@substrat-run/contracts';
import {
  drainScopePlatformRequests,
  provisionSiblingHandler,
  archiveScopeHandler,
  type PlatformRequestHandler,
  VerticalClient,
} from '../src/index.js';

/** A minimal well-formed intent row for the dispatcher tests. */
function intent(kind: string, over: Partial<PlatformRequest> = {}): PlatformRequest {
  return {
    id: platformRequestId.parse(ulid()),
    kind,
    payload: {},
    requestedBy: principalId.parse(ulid()),
    status: 'pending',
    attempts: 0,
    lastError: null,
    result: null,
    requestedAt: new Date().toISOString() as PlatformRequest['requestedAt'],
    settledAt: null,
    ...over,
  };
}

/** A fake VerticalClient transport that records settlements. */
function fakeTransport(pending: PlatformRequest[]) {
  const settled: Array<{ id: string; status: string; result?: unknown; lastError?: string | null }> = [];
  const client = {
    listPlatformRequests: async () => pending,
    settlePlatformRequest: async (
      _t: unknown,
      _s: unknown,
      id: string,
      outcome: { status: string; result?: unknown; lastError?: string | null },
    ) => {
      settled.push({ id, ...outcome });
    },
  } as unknown as Pick<VerticalClient, 'listPlatformRequests' | 'settlePlatformRequest'>;
  return { client, settled };
}

describe('drainScopePlatformRequests — the kind→handler dispatcher', () => {
  const ctx = { tenantId: tenantId.parse(ulid()), scopeId: scopeId.parse(ulid()), vertical: 'demo-vert' };

  it('dispatches to the handler for each kind and settles its outcome', async () => {
    const done = intent('provision-sibling');
    const { client, settled } = fakeTransport([done]);
    const handler: PlatformRequestHandler = async () => ({ status: 'done', result: { scopeId: 'NEW' } });

    const report = await drainScopePlatformRequests(client, ctx, { 'provision-sibling': handler });

    expect(report).toEqual({ drained: 1, done: 1, failed: 0, pending: 0 });
    expect(settled).toEqual([{ id: done.id, status: 'done', result: { scopeId: 'NEW' }, lastError: null }]);
  });

  it('settles an unknown kind as failed — never a silent drop', async () => {
    const unknown = intent('mystery');
    const { client, settled } = fakeTransport([unknown]);
    const report = await drainScopePlatformRequests(client, ctx, {});
    expect(report.failed).toBe(1);
    expect(settled[0]!.status).toBe('failed');
    expect(settled[0]!.lastError).toMatch(/no handler for platform-request kind 'mystery'/);
  });

  it('a thrown handler settles pending (transient — retried next drain)', async () => {
    const req = intent('provision-sibling');
    const { client, settled } = fakeTransport([req]);
    const boom: PlatformRequestHandler = async () => {
      throw new Error('vertical unreachable');
    };
    const report = await drainScopePlatformRequests(client, ctx, { 'provision-sibling': boom });
    expect(report.pending).toBe(1);
    expect(settled[0]!.status).toBe('pending');
    expect(settled[0]!.lastError).toMatch(/vertical unreachable/);
  });
});

describe('provisionSiblingHandler — provisions a sibling of the drained scope', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const parent = scopeId.parse(ulid());
  const owner = principalId.parse(ulid());

  let captured: { scopeId?: string; owner?: string; entitlements?: EntitlementGrant[] } | undefined;
  const fakeVertical = {
    provisionInstance: async (input: { scopeId: string; owner: string; entitlements?: EntitlementGrant[] }) => {
      captured = input;
      return { tenantId: t, scopeId: input.scopeId, owner };
    },
  } as unknown as VerticalClient;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-drain-'));
    host = new SqliteScopeHost({ dir });
    await host.admin.createTenant(staff, { id: t, slug: 'acme', name: 'Acme' });
    await host.provisionScope(staff, { tenantId: t, scopeId: parent, vertical: 'demo-vert' });
    await host.admin.activateScope(staff, t, parent);
    await host.admin.grantEntitlement(staff, t, 'demo-vert', { quota: 5, plan: 'pro' });
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('provisions + activates the sibling under the parent tenant, seating the owner', async () => {
    const handler = provisionSiblingHandler({
      host,
      actor: staff,
      resolveVerticalForScope: async () => fakeVertical,
    });
    const req = intent('provision-sibling', { payload: { slug: 'padel', name: 'Padel Club', owner } });

    const outcome = await handler({ tenantId: t, scopeId: parent, vertical: 'demo-vert' }, req);

    expect(outcome.status).toBe('done');
    const newScopeId = (outcome.result as { scopeId: string }).scopeId;
    // The sibling exists, is active, and inherited the parent's vertical.
    const record = await host.admin.getScopeRecord(staff, t, scopeId.parse(newScopeId));
    expect(record?.status).toBe('active');
    expect(record?.vertical).toBe('demo-vert');
    // The vertical materialized the instance with the seated owner + the platform-gathered plan.
    expect(captured?.scopeId).toBe(newScopeId);
    expect(captured?.owner).toBe(owner);
    expect(captured?.entitlements?.find((e) => e.entitlementKey === 'demo-vert')).toMatchObject({ quota: 5 });
  });
});

describe('archiveScopeHandler — archives a sibling named in the intent', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const current = scopeId.parse(ulid()); // the scope the intent was drained from
  const target = scopeId.parse(ulid()); // the sibling to archive

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-archive-'));
    host = new SqliteScopeHost({ dir });
    await host.admin.createTenant(staff, { id: t, slug: 'acme', name: 'Acme' });
    for (const s of [current, target]) {
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'demo-vert' });
      await host.admin.activateScope(staff, t, s);
    }
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const handler = () => archiveScopeHandler({ host, actor: staff });
  const ctx = { tenantId: t, scopeId: current, vertical: 'demo-vert' };

  it('archives the target scope, and is idempotent on a re-run', async () => {
    const outcome = await handler()(ctx, intent('archive-scope', { payload: { scopeId: target } }));
    expect(outcome.status).toBe('done');
    expect((await host.admin.getScopeRecord(staff, t, target))?.status).toBe('archived');

    // Idempotent: an already-archived target is a no-op success (a retry never wedges).
    const again = await handler()(ctx, intent('archive-scope', { payload: { scopeId: target } }));
    expect(again.status).toBe('done');
  });

  it('refuses a target running a different vertical (bounded to the drained scope\'s vertical)', async () => {
    const foreign = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: foreign, vertical: 'other-vert' });
    await host.admin.activateScope(staff, t, foreign);

    const outcome = await handler()(ctx, intent('archive-scope', { payload: { scopeId: foreign } }));
    expect(outcome.status).toBe('failed');
    expect((await host.admin.getScopeRecord(staff, t, foreign))?.status).toBe('active'); // untouched
  });
});
